import type { Vec3, VolumeData } from '../types';

export interface SubVolume {
  data: Float32Array;
  dims: Vec3;
  origin: Vec3;  // 第一个采样点的毫米坐标（体素局部坐标系）
  spacing: Vec3;
}

export interface VoxelBox {
  min: Vec3;
  max: Vec3; // 含端点
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

export const fullVoxelBox = (volume: VolumeData): VoxelBox => ({
  min: [0, 0, 0],
  max: [volume.dims[0] - 1, volume.dims[1] - 1, volume.dims[2] - 1]
});

export const mmBoxToVoxelBox = (volume: VolumeData, minMm: Vec3, maxMm: Vec3, marginMm: number): VoxelBox => {
  const box: VoxelBox = { min: [0, 0, 0], max: [0, 0, 0] };
  for (let a = 0; a < 3; a++) {
    box.min[a] = clamp(Math.floor((minMm[a] - marginMm) / volume.spacing[a]), 0, volume.dims[a] - 1);
    box.max[a] = clamp(Math.ceil((maxMm[a] + marginMm) / volume.spacing[a]), 0, volume.dims[a] - 1);
  }
  return box;
};

// 让全体积等值面的网格规模保持在可交互范围内：返回每个方向的降采样步长。
export const chooseSurfaceStep = (volume: VolumeData, maxCells = 20_000_000) => {
  const total = volume.dims[0] * volume.dims[1] * volume.dims[2];
  return Math.max(1, Math.ceil(Math.cbrt(total / maxCells)));
};

// 取出子体积；step > 1 时按 step^3 的块做平均，既降采样又抑制噪声。
export const extractSubVolume = (volume: VolumeData, box: VoxelBox, step: number): SubVolume => {
  const [nx, ny] = volume.dims;
  const dims: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) dims[a] = Math.max(1, Math.floor((box.max[a] - box.min[a] + 1) / step));
  const out = new Float32Array(dims[0] * dims[1] * dims[2]);
  const src = volume.data;
  const inv = 1 / (step * step * step);
  let o = 0;
  for (let z = 0; z < dims[2]; z++) {
    const k0 = box.min[2] + z * step;
    for (let y = 0; y < dims[1]; y++) {
      const j0 = box.min[1] + y * step;
      for (let x = 0; x < dims[0]; x++, o++) {
        const i0 = box.min[0] + x * step;
        if (step === 1) {
          out[o] = src[i0 + nx * (j0 + ny * k0)];
          continue;
        }
        let sum = 0;
        for (let dk = 0; dk < step; dk++) {
          for (let dj = 0; dj < step; dj++) {
            const row = i0 + nx * (j0 + dj + ny * (k0 + dk));
            for (let di = 0; di < step; di++) sum += src[row + di];
          }
        }
        out[o] = sum * inv;
      }
    }
  }
  const half = (step - 1) / 2;
  return {
    data: out,
    dims,
    origin: [
      (box.min[0] + half) * volume.spacing[0],
      (box.min[1] + half) * volume.spacing[1],
      (box.min[2] + half) * volume.spacing[2]
    ],
    spacing: [volume.spacing[0] * step, volume.spacing[1] * step, volume.spacing[2] * step]
  };
};

// 可分离 1-2-1 平滑，原地处理，用于全分辨率 ROI 提取等值面前降噪。
export const smoothSubVolume = (sub: SubVolume) => {
  const [nx, ny, nz] = sub.dims;
  const data = sub.data;
  const strides = [1, nx, nx * ny];
  const line = new Float32Array(Math.max(nx, ny, nz));
  for (let axis = 0; axis < 3; axis++) {
    const n = sub.dims[axis];
    if (n < 3) continue;
    const stride = strides[axis];
    const uCount = sub.dims[(axis + 1) % 3];
    const vCount = sub.dims[(axis + 2) % 3];
    const uStride = strides[(axis + 1) % 3];
    const vStride = strides[(axis + 2) % 3];
    for (let v = 0; v < vCount; v++) {
      for (let u = 0; u < uCount; u++) {
        const start = u * uStride + v * vStride;
        for (let i = 0; i < n; i++) line[i] = data[start + i * stride];
        for (let i = 1; i < n - 1; i++) data[start + i * stride] = 0.25 * line[i - 1] + 0.5 * line[i] + 0.25 * line[i + 1];
      }
    }
  }
};

const HIST_MIN = -1024;
const HIST_BIN = 16;
const HIST_BINS = 512; // 覆盖 -1024 ~ 7168

const otsu = (hist: Float64Array, from: number) => {
  let total = 0, sumAll = 0;
  for (let i = from; i < hist.length; i++) { total += hist[i]; sumAll += hist[i] * i; }
  if (!total) return from;
  let best = from, bestVar = -1, w0 = 0, sum0 = 0;
  for (let i = from; i < hist.length - 1; i++) {
    w0 += hist[i];
    sum0 += hist[i] * i;
    const w1 = total - w0;
    if (!w0 || !w1) continue;
    const diff = sum0 / w0 - (sumAll - sum0) / w1;
    const between = w0 * w1 * diff * diff;
    if (between > bestVar) { bestVar = between; best = i; }
  }
  return best;
};

// CBCT 灰度并非严格标定的 HU，不同机型差异很大，所以用逐级 Otsu 从直方图里估计：
// 空气|软组织 -> 软组织|骨 -> 骨|牙，分别作为“骨”和“牙”预设阈值。
export const suggestThresholds = (volume: VolumeData) => {
  const { data, dims } = volume;
  const total = dims[0] * dims[1] * dims[2];
  const stride = Math.max(1, Math.floor(total / 4_000_000));
  const hist = new Float64Array(HIST_BINS);
  for (let i = 0; i < total; i += stride) {
    const bin = Math.floor((data[i] - HIST_MIN) / HIST_BIN);
    hist[clamp(bin, 0, HIST_BINS - 1)]++;
  }
  const t1 = otsu(hist, 0);
  const t2 = otsu(hist, t1 + 1);
  const t3 = otsu(hist, t2 + 1);
  const toValue = (bin: number) => HIST_MIN + (bin + 1) * HIST_BIN;
  return { bone: toValue(t2), teeth: toValue(t3) };
};

export const voxelAt = (volume: VolumeData, x: number, y: number, z: number) => {
  const i = Math.round(x / volume.spacing[0]);
  const j = Math.round(y / volume.spacing[1]);
  const k = Math.round(z / volume.spacing[2]);
  if (i < 0 || j < 0 || k < 0 || i >= volume.dims[0] || j >= volume.dims[1] || k >= volume.dims[2]) return null;
  return volume.data[i + volume.dims[0] * (j + volume.dims[1] * k)];
};

export const computeRange = (data: Int16Array): [number, number] => {
  let lo = Infinity, hi = -Infinity;
  const stride = Math.max(1, Math.floor(data.length / 2_000_000));
  for (let i = 0; i < data.length; i += stride) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
};
