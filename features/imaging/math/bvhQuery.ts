import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { ClosestQuery } from './icp.ts';

// 用 three-mesh-bvh 为目标表面建立 BVH，返回“最近表面点 + 面法向”查询函数。
// 注意：MeshBVH 构建时会原地重排 indices。
export const createSurfaceQuery = (positions: Float32Array, indices: Uint32Array): ClosestQuery => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const bvh = new MeshBVH(geometry);
  const point = new Vector3();
  const target = { point: new Vector3(), distance: 0, faceIndex: 0 };

  return (x, y, z, maxDistance, out) => {
    point.set(x, y, z);
    if (!bvh.closestPointToPoint(point, target, 0, maxDistance)) return false;
    const a = indices[target.faceIndex * 3] * 3;
    const b = indices[target.faceIndex * 3 + 1] * 3;
    const c = indices[target.faceIndex * 3 + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    out.x = target.point.x; out.y = target.point.y; out.z = target.point.z;
    out.nx = nx; out.ny = ny; out.nz = nz;
    out.distance = target.distance;
    return true;
  };
};
