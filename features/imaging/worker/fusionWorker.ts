/// <reference lib="webworker" />
import { generatePhantom } from '../demo/phantom.ts';
import { createSurfaceQuery } from '../math/bvhQuery.ts';
import { calibrateEdgeLevel, createSampler } from '../math/calibrate.ts';
import { runIcp, type ClosestHit, type ClosestQuery } from '../math/icp.ts';
import { removeSmallComponents, surfaceNets } from '../math/surfaceNets.ts';
import { smoothSubVolume, type SubVolume } from '../math/volume.ts';
import type { SurfaceMesh } from '../types';
import type { FusionRequest, FusionResponse } from './protocol.ts';

// 等值面提取、BVH 构建、ICP 等重计算都放在这里，避免卡住界面。
const scope = self as unknown as DedicatedWorkerGlobalScope;

let displayVolume: SubVolume | null = null;
let targetQuery: ClosestQuery | null = null;

const extract = (sub: SubVolume, iso: number, minComponent: number): SurfaceMesh => {
  const mesh = removeSmallComponents(surfaceNets(sub.data, sub.dims, iso), minComponent);
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = sub.origin[0] + p[i] * sub.spacing[0];
    p[i + 1] = sub.origin[1] + p[i + 1] * sub.spacing[1];
    p[i + 2] = sub.origin[2] + p[i + 2] * sub.spacing[2];
  }
  return mesh;
};

const reply = (message: FusionResponse, transfer: Transferable[] = []) => scope.postMessage(message, transfer);

scope.onmessage = (event: MessageEvent<FusionRequest>) => {
  const task = event.data;
  try {
    switch (task.type) {
      case 'phantom': {
        const result = generatePhantom();
        reply({ id: task.id, kind: 'done', result }, [result.volume.data.buffer, result.ios.positions.buffer, result.ios.indices.buffer]);
        break;
      }
      case 'setDisplayVolume':
        displayVolume = task.sub;
        reply({ id: task.id, kind: 'done', result: { ok: true } });
        break;
      case 'displaySurface': {
        if (!displayVolume) throw new Error('尚未载入 CBCT。');
        const mesh = extract(displayVolume, task.iso, task.minComponent);
        reply({ id: task.id, kind: 'done', result: mesh }, [mesh.positions.buffer, mesh.indices.buffer]);
        break;
      }
      case 'register': {
        // 两段式：先对人工阈值下的牙面做 ICP，再用自校准的边缘灰度重提牙面精修一轮。
        const { sub, points, normals } = task;
        smoothSubVolume(sub);
        const build = (iso: number) => {
          const mesh = extract(sub, iso, 80);
          if (mesh.indices.length < 300) throw new Error('当前阈值下，口扫附近几乎提取不到 CBCT 牙面，请调低阈值或检查粗配准。');
          return createSurfaceQuery(mesh.positions, mesh.indices);
        };
        const progress = (stage: string) => (iteration: number, rms: number, inliers: number) =>
          reply({ id: task.id, kind: 'progress', stage, iteration, rms, inliers });

        targetQuery = build(task.iso);
        let result = runIcp(points, normals, targetQuery, { initial: task.initial, startDistance: task.startDistance, onIteration: progress('ICP 精配准') });
        const voxel = Math.max(sub.spacing[0], sub.spacing[1], sub.spacing[2]);
        const calibratedIso = result.summary.matched >= 200
          ? calibrateEdgeLevel(points, normals, result.matrix, result.summary.normalsFlipped ? -1 : 1, targetQuery, createSampler(sub), voxel, task.iso)
          : null;
        if (calibratedIso !== null) {
          targetQuery = build(calibratedIso);
          result = runIcp(points, normals, targetQuery, {
            initial: result.matrix,
            startDistance: 1,
            minDistance: 0.25,
            maxIterations: 40,
            onIteration: progress('阈值校准后精修')
          });
        }
        reply({ id: task.id, kind: 'done', result: { ...result, calibratedIso } });
        break;
      }
      case 'distances': {
        if (!targetQuery) throw new Error('尚未建立 CBCT 配准目标面。');
        const { positions, matrix: m, maxDistance } = task;
        const count = positions.length / 3;
        const distances = new Float32Array(count);
        const hit: ClosestHit = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, distance: 0 };
        for (let i = 0; i < count; i++) {
          const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
          const found = targetQuery(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
            maxDistance,
            hit
          );
          distances[i] = found ? hit.distance : -1;
        }
        reply({ id: task.id, kind: 'done', result: { distances } }, [distances.buffer]);
        break;
      }
    }
  } catch (error) {
    reply({ id: task.id, kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
