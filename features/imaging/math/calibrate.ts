import type { ClosestHit, ClosestQuery } from './icp.ts';
import type { SubVolume } from './volume.ts';

// 子体积上的三线性插值采样（输入为体素局部毫米坐标），越界返回 NaN。
export const createSampler = (sub: SubVolume) => {
  const [nx, ny, nz] = sub.dims;
  const { data, origin, spacing } = sub;
  const nxy = nx * ny;
  return (x: number, y: number, z: number) => {
    const fx = (x - origin[0]) / spacing[0], fy = (y - origin[1]) / spacing[1], fz = (z - origin[2]) / spacing[2];
    if (!(fx >= 0 && fy >= 0 && fz >= 0 && fx <= nx - 1 && fy <= ny - 1 && fz <= nz - 1)) return NaN;
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy)), k = Math.min(nz - 2, Math.floor(fz));
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const base = i + nx * j + nxy * k;
    const c00 = data[base] + tx * (data[base + 1] - data[base]);
    const c10 = data[base + nx] + tx * (data[base + nx + 1] - data[base + nx]);
    const c01 = data[base + nxy] + tx * (data[base + nxy + 1] - data[base + nxy]);
    const c11 = data[base + nxy + nx] + tx * (data[base + nxy + nx + 1] - data[base + nxy + nx]);
    const c0 = c00 + ty * (c10 - c00), c1 = c01 + ty * (c11 - c01);
    return c0 + tz * (c1 - c0);
  };
};

// 牙面阈值自校准。
// 等值面的位置随阈值移动：阈值高于牙釉质边缘的“半高”灰度时，CBCT 牙冠整体内缩，反之外扩，
// 口扫只盖住牙冠的上半部分，这种内缩/外扩会被刚体配准吸收成一个系统性的平移。
// 这里在已经贴合的口扫采样点上，沿法向向内、向外各取一段灰度，取“内侧平台 + 外侧平台”的一半
// 作为边缘灰度，对所有点取中位数，得到与人工阈值无关的牙面等值。
export const calibrateEdgeLevel = (
  points: Float32Array,
  normals: Float32Array,
  matrix: ArrayLike<number>,
  normalSign: number,
  query: ClosestQuery,
  sample: (x: number, y: number, z: number) => number,
  voxel: number,
  iso: number
): number | null => {
  const m = matrix;
  const offsets = [1.5, 2, 2.5, 3].map(v => v * voxel);
  const hit: ClosestHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
  const levels: number[] = [];
  const minContrast = Math.abs(iso) * 0.4;
  for (let i = 0; i < points.length; i += 3) {
    const px = points[i], py = points[i + 1], pz = points[i + 2];
    const x = m[0] * px + m[4] * py + m[8] * pz + m[12];
    const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
    const z = m[2] * px + m[6] * py + m[10] * pz + m[14];
    if (!query(x, y, z, voxel, hit)) continue;
    const nx = (m[0] * normals[i] + m[4] * normals[i + 1] + m[8] * normals[i + 2]) * normalSign;
    const ny = (m[1] * normals[i] + m[5] * normals[i + 1] + m[9] * normals[i + 2]) * normalSign;
    const nz = (m[2] * normals[i] + m[6] * normals[i + 1] + m[10] * normals[i + 2]) * normalSign;
    let inside = -Infinity, outside = Infinity;
    for (const t of offsets) {
      const a = sample(x - nx * t, y - ny * t, z - nz * t);
      const b = sample(x + nx * t, y + ny * t, z + nz * t);
      if (a > inside) inside = a;
      if (b < outside) outside = b;
    }
    // 邻牙接触区、牙龈覆盖区等位置内外反差不足，不参与估计。
    if (!(inside - outside >= minContrast)) continue;
    levels.push((inside + outside) / 2);
  }
  if (levels.length < 200) return null;
  levels.sort((a, b) => a - b);
  return levels[levels.length >> 1];
};
