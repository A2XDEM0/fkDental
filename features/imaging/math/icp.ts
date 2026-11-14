import type { DeviationStats, IcpSummary, Mat4 } from '../types';
import { fitRigid, fromAxisAngle, multiply } from './rigid.ts';

export interface ClosestHit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  distance: number;
}

// 在目标表面上查询最近点；超过 maxDistance 时返回 false。
export type ClosestQuery = (x: number, y: number, z: number, maxDistance: number, out: ClosestHit) => boolean;

export interface IcpOptions {
  initial: Mat4;
  maxIterations?: number;
  startDistance?: number; // 初始对应点搜索半径 (mm)，取决于粗配准的可信程度
  minDistance?: number;   // 修剪阈值下限 (mm)，防止迭代后期把真实牙面也剪掉
  normalCos?: number;     // 法向一致性阈值；<= -1 表示不检查
  onIteration?: (iteration: number, rms: number, inliers: number) => void;
}

export interface IcpResult {
  matrix: Mat4;
  summary: IcpSummary;
}

const solve6 = (A: Float64Array, b: Float64Array) => {
  const n = 6;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r * n + col]) > Math.abs(A[pivot * n + col])) pivot = r;
    if (Math.abs(A[pivot * n + col]) < 1e-12) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const tmp = A[col * n + c]; A[col * n + c] = A[pivot * n + c]; A[pivot * n + c] = tmp;
      }
      const tb = b[col]; b[col] = b[pivot]; b[pivot] = tb;
    }
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col] / A[col * n + col];
      if (!f) continue;
      for (let c = col; c < n; c++) A[r * n + c] -= f * A[col * n + c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= A[r * n + c] * x[c];
    x[r] = sum / A[r * n + r];
  }
  return x;
};

const median = (values: Float32Array, count: number) => {
  if (!count) return 0;
  const sorted = values.slice(0, count).sort();
  return sorted[count >> 1];
};

export const summarizeDistances = (distances: ArrayLike<number>, total: number): DeviationStats => {
  const count = distances.length;
  if (!count) return { rms: 0, mean: 0, median: 0, p95: 0, matched: 0, total, within02: 0, within05: 0 };
  const sorted = Float32Array.from(distances).sort();
  let sum = 0, sumSq = 0, w02 = 0, w05 = 0;
  for (let i = 0; i < count; i++) {
    const d = sorted[i];
    sum += d; sumSq += d * d;
    if (d <= 0.2) w02++;
    if (d <= 0.5) w05++;
  }
  return {
    rms: Math.sqrt(sumSq / count),
    mean: sum / count,
    median: sorted[count >> 1],
    p95: sorted[Math.min(count - 1, Math.floor(count * 0.95))],
    matched: count,
    total,
    within02: w02 / count,
    within05: w05 / count
  };
};

// 修剪式 ICP：前几轮用点到点稳住位姿，之后切换到点到面加速收敛。
// 口扫包含牙龈、CBCT 等值面包含牙根和骨，两者只有牙冠表面真正重合，
// 因此每轮都按稳健尺度 (MAD) 和法向一致性剔除没有对应面的点。
export const runIcp = (points: Float32Array, normals: Float32Array | null, query: ClosestQuery, options: IcpOptions): IcpResult => {
  const total = Math.floor(points.length / 3);
  const maxIterations = options.maxIterations ?? 60;
  const minDistance = options.minDistance ?? 0.4;
  const normalCos = options.normalCos ?? 0.3;
  let searchRadius = options.startDistance ?? 3;
  let T: Mat4 = Float64Array.from(options.initial);

  const moved = new Float32Array(total * 3);
  const closest = new Float32Array(total * 3);
  const hitNormals = new Float32Array(total * 3);
  const dist = new Float32Array(total);
  const scratch = new Float32Array(total);
  const valid = new Uint8Array(total);
  const hit: ClosestHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, distance: 0 };

  let normalSign = 0;
  let cut = searchRadius;
  let iterations = 0;
  let converged = false;
  let stableSteps = 0;

  const match = () => {
    let agree = 0, disagree = 0;
    for (let i = 0; i < total; i++) {
      const px = points[i * 3], py = points[i * 3 + 1], pz = points[i * 3 + 2];
      const x = T[0] * px + T[4] * py + T[8] * pz + T[12];
      const y = T[1] * px + T[5] * py + T[9] * pz + T[13];
      const z = T[2] * px + T[6] * py + T[10] * pz + T[14];
      moved[i * 3] = x; moved[i * 3 + 1] = y; moved[i * 3 + 2] = z;
      valid[i] = 0;
      if (!query(x, y, z, searchRadius, hit)) continue;
      closest[i * 3] = hit.x; closest[i * 3 + 1] = hit.y; closest[i * 3 + 2] = hit.z;
      hitNormals[i * 3] = hit.nx; hitNormals[i * 3 + 1] = hit.ny; hitNormals[i * 3 + 2] = hit.nz;
      dist[i] = hit.distance;
      valid[i] = 1;
      if (normals && normalCos > -1) {
        const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
        const dot = (T[0] * nx + T[4] * ny + T[8] * nz) * hit.nx
          + (T[1] * nx + T[5] * ny + T[9] * nz) * hit.ny
          + (T[2] * nx + T[6] * ny + T[10] * nz) * hit.nz;
        if (normalSign === 0) {
          if (dot > 0) agree++; else disagree++;
          scratch[i] = dot;
        } else if (dot * normalSign < normalCos) {
          valid[i] = 0;
        }
      }
    }
    // 首轮自动判断两套网格的法向约定是否相反（例如导出的 STL 面片朝内）。
    if (normals && normalCos > -1 && normalSign === 0) {
      normalSign = agree >= disagree ? 1 : -1;
      for (let i = 0; i < total; i++) if (valid[i] && scratch[i] * normalSign < normalCos) valid[i] = 0;
    }
    let n = 0;
    for (let i = 0; i < total; i++) if (valid[i]) scratch[n++] = dist[i];
    const sigma = 1.4826 * median(scratch, n);
    cut = Math.min(searchRadius, Math.max(minDistance, 3 * sigma));
    let inliers = 0;
    for (let i = 0; i < total; i++) {
      if (valid[i] && dist[i] > cut) valid[i] = 0;
      if (valid[i]) inliers++;
    }
    return inliers;
  };

  for (let it = 0; it < maxIterations; it++) {
    const inliers = match();
    if (inliers < 12) break;
    iterations = it + 1;

    let sumSq = 0;
    for (let i = 0; i < total; i++) if (valid[i]) sumSq += dist[i] * dist[i];
    options.onIteration?.(iterations, Math.sqrt(sumSq / inliers), inliers);

    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < total; i++) {
      if (!valid[i]) continue;
      cx += moved[i * 3]; cy += moved[i * 3 + 1]; cz += moved[i * 3 + 2];
    }
    cx /= inliers; cy /= inliers; cz /= inliers;

    let delta: Mat4 | null = null;
    if (it >= 4) {
      const A = new Float64Array(36);
      const b = new Float64Array(6);
      const row = new Float64Array(6);
      for (let i = 0; i < total; i++) {
        if (!valid[i]) continue;
        const qx = moved[i * 3] - cx, qy = moved[i * 3 + 1] - cy, qz = moved[i * 3 + 2] - cz;
        const nx = hitNormals[i * 3], ny = hitNormals[i * 3 + 1], nz = hitNormals[i * 3 + 2];
        const r = (moved[i * 3] - closest[i * 3]) * nx + (moved[i * 3 + 1] - closest[i * 3 + 1]) * ny + (moved[i * 3 + 2] - closest[i * 3 + 2]) * nz;
        row[0] = qy * nz - qz * ny; row[1] = qz * nx - qx * nz; row[2] = qx * ny - qy * nx;
        row[3] = nx; row[4] = ny; row[5] = nz;
        for (let p = 0; p < 6; p++) {
          b[p] -= row[p] * r;
          for (let q = 0; q < 6; q++) A[p * 6 + q] += row[p] * row[q];
        }
      }
      let trace = 0;
      for (let p = 0; p < 6; p++) trace += A[p * 7];
      for (let p = 0; p < 6; p++) A[p * 7] += trace * 1e-9;
      const x = solve6(A, b);
      if (x) {
        const angle = Math.hypot(x[0], x[1], x[2]);
        const rot = angle > 1e-12 ? fromAxisAngle([x[0], x[1], x[2]], angle) : fromAxisAngle([0, 0, 1], 0);
        // 旋转绕内点质心进行：p -> R(p - c) + c + t
        rot[12] = cx + x[3] - (rot[0] * cx + rot[4] * cy + rot[8] * cz);
        rot[13] = cy + x[4] - (rot[1] * cx + rot[5] * cy + rot[9] * cz);
        rot[14] = cz + x[5] - (rot[2] * cx + rot[6] * cy + rot[10] * cz);
        delta = rot;
      }
    }
    if (!delta) {
      const src = new Float64Array(inliers * 3);
      const dst = new Float64Array(inliers * 3);
      let n = 0;
      for (let i = 0; i < total; i++) {
        if (!valid[i]) continue;
        src[n * 3] = moved[i * 3]; src[n * 3 + 1] = moved[i * 3 + 1]; src[n * 3 + 2] = moved[i * 3 + 2];
        dst[n * 3] = closest[i * 3]; dst[n * 3 + 1] = closest[i * 3 + 1]; dst[n * 3 + 2] = closest[i * 3 + 2];
        n++;
      }
      delta = fitRigid(src, dst, n);
    }

    // 用内点质心的位移和旋转角衡量本轮位姿变化，连续两轮几乎不动即认为收敛。
    const rotStep = Math.acos(Math.max(-1, Math.min(1, (delta[0] + delta[5] + delta[10] - 1) / 2)));
    const shift = Math.hypot(
      delta[0] * cx + delta[4] * cy + delta[8] * cz + delta[12] - cx,
      delta[1] * cx + delta[5] * cy + delta[9] * cz + delta[13] - cy,
      delta[2] * cx + delta[6] * cy + delta[10] * cz + delta[14] - cz
    );
    T = multiply(delta, T);
    searchRadius = Math.max(minDistance * 2, Math.min(searchRadius, cut * 1.5));

    if (rotStep < 2e-5 && shift < 5e-4) {
      stableSteps++;
      if (stableSteps >= 2) { converged = true; break; }
    } else {
      stableSteps = 0;
    }
  }

  const inliers = match();
  const finalDistances = new Float32Array(inliers);
  let n = 0;
  for (let i = 0; i < total; i++) if (valid[i]) finalDistances[n++] = dist[i];
  return {
    matrix: T,
    summary: {
      ...summarizeDistances(finalDistances, total),
      iterations,
      converged,
      normalsFlipped: normalSign < 0
    }
  };
};
