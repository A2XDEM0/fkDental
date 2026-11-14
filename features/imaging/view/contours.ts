import type { SurfaceMesh } from '../types';

export type SliceAxis = 0 | 1 | 2; // 垂直于切面的体素轴：0 矢状，1 冠状，2 轴位

export const sliceAxes = (axis: SliceAxis) => ({
  h: (axis === 0 ? 1 : 0) as SliceAxis,
  v: (axis === 2 ? 1 : 2) as SliceAxis,
  flipV: axis !== 2 // 冠状/矢状面把头侧画在上方
});

// 网格与轴对齐切面的交线，返回切面内的线段端点 [h0, v0, h1, v1, ...]（毫米）。
// positions 需已变换到 CBCT 体素坐标系；三角面数量在百万以内时直接遍历即可满足实时刷新。
export const sliceContour = (positions: Float32Array, indices: Uint32Array, axis: SliceAxis, plane: number): Float32Array => {
  const { h, v } = sliceAxes(axis);
  let out = new Float32Array(4096);
  let n = 0;
  const point = [0, 0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const da = positions[a + axis] - plane, db = positions[b + axis] - plane, dc = positions[c + axis] - plane;
    if ((da > 0 && db > 0 && dc > 0) || (da <= 0 && db <= 0 && dc <= 0)) continue;
    let k = 0;
    if (da > 0 !== db > 0) {
      const f = da / (da - db);
      point[k++] = positions[a + h] + f * (positions[b + h] - positions[a + h]);
      point[k++] = positions[a + v] + f * (positions[b + v] - positions[a + v]);
    }
    if (db > 0 !== dc > 0) {
      const f = db / (db - dc);
      point[k++] = positions[b + h] + f * (positions[c + h] - positions[b + h]);
      point[k++] = positions[b + v] + f * (positions[c + v] - positions[b + v]);
    }
    if (k < 4 && dc > 0 !== da > 0) {
      const f = dc / (dc - da);
      point[k++] = positions[c + h] + f * (positions[a + h] - positions[c + h]);
      point[k++] = positions[c + v] + f * (positions[a + v] - positions[c + v]);
    }
    if (k < 4) continue;
    if (n + 4 > out.length) {
      const next = new Float32Array(out.length * 2);
      next.set(out);
      out = next;
    }
    out[n++] = point[0]; out[n++] = point[1]; out[n++] = point[2]; out[n++] = point[3];
  }
  return out.subarray(0, n);
};

export const transformPositions = (positions: Float32Array, m: ArrayLike<number>) => {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
};

export const computeVertexNormals = (mesh: SurfaceMesh) => {
  const { positions, indices } = mesh;
  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
};
