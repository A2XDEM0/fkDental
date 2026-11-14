import type { Mat4, Vec3 } from '../types';

export const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

export const multiply = (a: ArrayLike<number>, b: ArrayLike<number>): Mat4 => {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
};

export const invertRigid = (m: ArrayLike<number>): Mat4 => {
  const out = identity();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c];
  }
  for (let r = 0; r < 3; r++) {
    out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
  }
  return out;
};

export const transformPoint = (m: ArrayLike<number>, x: number, y: number, z: number): Vec3 => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14]
];

export const fromQuaternion = (w: number, x: number, y: number, z: number, t: Vec3 = [0, 0, 0]): Mat4 => {
  const n = Math.hypot(w, x, y, z) || 1;
  w /= n; x /= n; y /= n; z /= n;
  const m = identity();
  m[0] = 1 - 2 * (y * y + z * z);
  m[1] = 2 * (x * y + w * z);
  m[2] = 2 * (x * z - w * y);
  m[4] = 2 * (x * y - w * z);
  m[5] = 1 - 2 * (x * x + z * z);
  m[6] = 2 * (y * z + w * x);
  m[8] = 2 * (x * z + w * y);
  m[9] = 2 * (y * z - w * x);
  m[10] = 1 - 2 * (x * x + y * y);
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
};

export const fromAxisAngle = (axis: Vec3, angle: number, t: Vec3 = [0, 0, 0]): Mat4 => {
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const s = Math.sin(angle / 2) / n;
  return fromQuaternion(Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s, t);
};

export const rotationAngle = (m: ArrayLike<number>) => {
  const cos = (m[0] + m[5] + m[10] - 1) / 2;
  return Math.acos(Math.max(-1, Math.min(1, cos)));
};

export const translationLength = (m: ArrayLike<number>) => Math.hypot(m[12], m[13], m[14]);

// 对称矩阵的循环 Jacobi 特征分解，返回特征值及按列存放的特征向量。
const jacobiEigen = (input: number[][]) => {
  const n = input.length;
  const a = input.map(row => row.slice());
  const v: number[][] = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: a.map((row, i) => row[i]), vectors: v };
};

// Horn 四元数闭式解：求把 src 点集对齐到 dst 点集的最小二乘刚体变换（不含缩放，不会产生镜像）。
export const fitRigid = (src: ArrayLike<number>, dst: ArrayLike<number>, count = Math.floor(src.length / 3)): Mat4 => {
  if (count < 3) throw new Error('刚体配准至少需要 3 对点');
  let sx = 0, sy = 0, sz = 0, dx = 0, dy = 0, dz = 0;
  for (let i = 0; i < count; i++) {
    sx += src[i * 3]; sy += src[i * 3 + 1]; sz += src[i * 3 + 2];
    dx += dst[i * 3]; dy += dst[i * 3 + 1]; dz += dst[i * 3 + 2];
  }
  sx /= count; sy /= count; sz /= count;
  dx /= count; dy /= count; dz /= count;

  const S = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < count; i++) {
    const px = src[i * 3] - sx, py = src[i * 3 + 1] - sy, pz = src[i * 3 + 2] - sz;
    const qx = dst[i * 3] - dx, qy = dst[i * 3 + 1] - dy, qz = dst[i * 3 + 2] - dz;
    S[0] += px * qx; S[1] += px * qy; S[2] += px * qz;
    S[3] += py * qx; S[4] += py * qy; S[5] += py * qz;
    S[6] += pz * qx; S[7] += pz * qy; S[8] += pz * qz;
  }
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]
  ];
  const { values, vectors } = jacobiEigen(N);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const m = fromQuaternion(vectors[0][best], vectors[1][best], vectors[2][best], vectors[3][best]);
  m[12] = dx - (m[0] * sx + m[4] * sy + m[8] * sz);
  m[13] = dy - (m[1] * sx + m[5] * sy + m[9] * sz);
  m[14] = dz - (m[2] * sx + m[6] * sy + m[10] * sz);
  return m;
};

// 逐点残差：|T·src - dst|。
export const pairResiduals = (m: ArrayLike<number>, src: ArrayLike<number>, dst: ArrayLike<number>, count = Math.floor(src.length / 3)) => {
  const residuals: number[] = [];
  for (let i = 0; i < count; i++) {
    const p = transformPoint(m, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    residuals.push(Math.hypot(p[0] - dst[i * 3], p[1] - dst[i * 3 + 1], p[2] - dst[i * 3 + 2]));
  }
  return residuals;
};

export const rootMeanSquare = (values: ArrayLike<number>) => {
  if (!values.length) return 0;
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / values.length);
};
