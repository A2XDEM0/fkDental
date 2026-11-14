import type { SurfaceMesh } from '../types';

class GrowableFloat32 {
  data = new Float32Array(1 << 16);
  length = 0;
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
}

class GrowableUint32 {
  data = new Uint32Array(1 << 16);
  length = 0;
  push3(a: number, b: number, c: number) {
    if (this.length + 3 > this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
}

const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
{
  let k = 0;
  for (let i = 0; i < 8; i++) {
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) {
        CUBE_EDGES[k++] = i;
        CUBE_EDGES[k++] = p;
      }
    }
  }
  for (let i = 0; i < 256; i++) {
    let em = 0;
    for (let j = 0; j < 24; j += 2) {
      const a = !!(i & (1 << CUBE_EDGES[j]));
      const b = !!(i & (1 << CUBE_EDGES[j + 1]));
      if (a !== b) em |= 1 << (j >> 1);
    }
    EDGE_TABLE[i] = em;
  }
}

// Naive Surface Nets 等值面提取（参考 Mikola Lysenko 的公开实现思路）。
// 取值 >= iso 的一侧视为物体内部，三角面法向朝外（指向低值一侧）。
// 输出顶点为体素索引坐标，由调用方乘以体素间距并加上原点。
export const surfaceNets = (data: ArrayLike<number>, dims: [number, number, number], iso: number): SurfaceMesh => {
  const [nx, ny, nz] = dims;
  const positions = new GrowableFloat32();
  const indices = new GrowableUint32();
  const R = [1, nx + 1, (nx + 1) * (ny + 1)];
  const buffer = new Int32Array(R[2] * 2);
  const grid = new Float64Array(8);
  const x = [0, 0, 0];
  const nxy = nx * ny;
  let bufNo = 1;
  let vertexCount = 0;

  for (x[2] = 0; x[2] < nz - 1; x[2]++, bufNo ^= 1, R[2] = -R[2]) {
    let m = 1 + (nx + 1) * (1 + bufNo * (ny + 1));
    for (x[1] = 0; x[1] < ny - 1; x[1]++, m += 2) {
      for (x[0] = 0; x[0] < nx - 1; x[0]++, m++) {
        const base = x[0] + nx * x[1] + nxy * x[2];
        let mask = 0;
        let g = 0;
        for (let k = 0; k < 2; k++) {
          for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 2; i++, g++) {
              const p = iso - data[base + i + j * nx + k * nxy];
              grid[g] = p;
              if (p <= 0) mask |= 1 << g;
            }
          }
        }
        if (mask === 0 || mask === 0xff) continue;

        const edgeMask = EDGE_TABLE[mask];
        let vx = 0, vy = 0, vz = 0, crossings = 0;
        for (let e = 0; e < 12; e++) {
          if (!(edgeMask & (1 << e))) continue;
          crossings++;
          const e0 = CUBE_EDGES[e << 1];
          const e1 = CUBE_EDGES[(e << 1) + 1];
          const g0 = grid[e0];
          const g1 = grid[e1];
          let t = g0 - g1;
          t = Math.abs(t) > 1e-9 ? g0 / t : 0.5;
          const a0 = e0 & 1, b0 = e1 & 1;
          vx += a0 !== b0 ? (a0 ? 1 - t : t) : a0;
          const a1 = (e0 >> 1) & 1, b1 = (e1 >> 1) & 1;
          vy += a1 !== b1 ? (a1 ? 1 - t : t) : a1;
          const a2 = (e0 >> 2) & 1, b2 = (e1 >> 2) & 1;
          vz += a2 !== b2 ? (a2 ? 1 - t : t) : a2;
        }
        const s = 1 / crossings;
        buffer[m] = vertexCount++;
        positions.push3(x[0] + s * vx, x[1] + s * vy, x[2] + s * vz);

        for (let i = 0; i < 3; i++) {
          if (!(edgeMask & (1 << i))) continue;
          const iu = (i + 1) % 3;
          const iv = (i + 2) % 3;
          if (x[iu] === 0 || x[iv] === 0) continue;
          const du = R[iu];
          const dv = R[iv];
          const a = buffer[m], b = buffer[m - du], c = buffer[m - du - dv], d = buffer[m - dv];
          if (mask & 1) {
            indices.push3(a, b, c);
            indices.push3(a, c, d);
          } else {
            indices.push3(a, d, c);
            indices.push3(a, c, b);
          }
        }
      }
    }
  }

  return {
    positions: positions.data.slice(0, positions.length),
    indices: indices.data.slice(0, indices.length)
  };
};

// 去除孤立小碎片（CBCT 噪声在阈值附近会产生大量悬浮小面片）。
export const removeSmallComponents = (mesh: SurfaceMesh, minTriangles: number): SurfaceMesh => {
  const vertexCount = mesh.positions.length / 3;
  const triCount = mesh.indices.length / 3;
  if (minTriangles <= 1 || triCount === 0) return mesh;

  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(mesh.indices[t * 3]);
    const b = find(mesh.indices[t * 3 + 1]);
    const c = find(mesh.indices[t * 3 + 2]);
    if (b !== a) parent[b] = a;
    if (c !== a) parent[find(c)] = a;
  }
  const triPerRoot = new Int32Array(vertexCount);
  for (let t = 0; t < triCount; t++) triPerRoot[find(mesh.indices[t * 3])]++;

  const remap = new Int32Array(vertexCount).fill(-1);
  const positions = new GrowableFloat32();
  const indices = new GrowableUint32();
  const colors = mesh.colors ? new GrowableFloat32() : null;
  let next = 0;
  const mapVertex = (v: number) => {
    if (remap[v] < 0) {
      remap[v] = next++;
      positions.push3(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      if (colors && mesh.colors) colors.push3(mesh.colors[v * 3], mesh.colors[v * 3 + 1], mesh.colors[v * 3 + 2]);
    }
    return remap[v];
  };
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3];
    if (triPerRoot[find(a)] < minTriangles) continue;
    indices.push3(mapVertex(a), mapVertex(mesh.indices[t * 3 + 1]), mapVertex(mesh.indices[t * 3 + 2]));
  }
  return {
    positions: positions.data.slice(0, positions.length),
    indices: indices.data.slice(0, indices.length),
    colors: colors ? colors.data.slice(0, colors.length) : undefined
  };
};
