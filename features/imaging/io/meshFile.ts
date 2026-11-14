import { BufferGeometry, Mesh } from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { SurfaceMesh } from '../types';

const toSurfaceMesh = (geometry: BufferGeometry): SurfaceMesh => {
  // 法向稍后统一重算；保留它会妨碍 STL 这类三角形汤合并重复顶点。
  geometry.deleteAttribute('normal');
  geometry.deleteAttribute('uv');
  const indexed = geometry.index ? geometry : mergeVertices(geometry, 1e-4);
  const position = indexed.getAttribute('position');
  const color = indexed.getAttribute('color');
  const positions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    positions[i * 3] = position.getX(i);
    positions[i * 3 + 1] = position.getY(i);
    positions[i * 3 + 2] = position.getZ(i);
  }
  let colors: Float32Array | undefined;
  if (color) {
    colors = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i++) {
      colors[i * 3] = color.getX(i);
      colors[i * 3 + 1] = color.getY(i);
      colors[i * 3 + 2] = color.getZ(i);
    }
  }
  const indices = Uint32Array.from(indexed.index!.array);
  if (indices.length < 3) throw new Error('模型文件里没有三角面。');
  return { positions, indices, colors };
};

// 读取口扫常见的导出格式：STL（二进制/ASCII）、PLY（可带顶点颜色）、OBJ。
export const loadMeshFile = (name: string, buffer: ArrayBuffer): SurfaceMesh => {
  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'stl') return toSurfaceMesh(new STLLoader().parse(buffer));
  if (extension === 'ply') return toSurfaceMesh(new PLYLoader().parse(buffer));
  if (extension === 'obj') {
    const group = new OBJLoader().parse(new TextDecoder().decode(buffer));
    const geometries: BufferGeometry[] = [];
    group.traverse(object => {
      if (object instanceof Mesh) {
        const geometry = object.geometry as BufferGeometry;
        for (const attribute of Object.keys(geometry.attributes)) {
          if (attribute !== 'position') geometry.deleteAttribute(attribute);
        }
        geometries.push(geometry);
      }
    });
    if (!geometries.length) throw new Error('OBJ 文件里没有网格。');
    return toSurfaceMesh(geometries.length === 1 ? geometries[0] : mergeGeometries(geometries));
  }
  throw new Error('暂不支持该模型格式，请使用 STL、PLY 或 OBJ。');
};

// 导出二进制 STL；传入矩阵时先把顶点变换到目标坐标系（例如 CBCT 患者坐标系）。
export const writeBinaryStl = (mesh: SurfaceMesh, matrix?: ArrayLike<number>): ArrayBuffer => {
  const triCount = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  const header = 'DentalSystem registered intraoral scan (mm)';
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, triCount, true);
  const p = new Float64Array(9);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    for (let c = 0; c < 3; c++) {
      const v = mesh.indices[t * 3 + c] * 3;
      const x = mesh.positions[v], y = mesh.positions[v + 1], z = mesh.positions[v + 2];
      if (matrix) {
        p[c * 3] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        p[c * 3 + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        p[c * 3 + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      } else {
        p[c * 3] = x; p[c * 3 + 1] = y; p[c * 3 + 2] = z;
      }
    }
    const e1x = p[3] - p[0], e1y = p[4] - p[1], e1z = p[5] - p[2];
    const e2x = p[6] - p[0], e2y = p[7] - p[1], e2z = p[8] - p[2];
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true);
    for (let i = 0; i < 9; i++) view.setFloat32(offset + 12 + i * 4, p[i], true);
    offset += 50;
  }
  return buffer;
};
