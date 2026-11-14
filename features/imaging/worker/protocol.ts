import type { IcpSummary, Mat4, SurfaceMesh, VolumeData } from '../types';
import type { SubVolume } from '../math/volume.ts';
import type { PhantomLandmarkHint } from '../demo/phantom.ts';

// 主线程 -> Worker 的任务。体数据子块用 transfer 传递，不做结构化拷贝。
export type FusionTask =
  | { type: 'phantom' }
  | { type: 'setDisplayVolume'; sub: SubVolume }
  | { type: 'displaySurface'; iso: number; minComponent: number }
  | { type: 'register'; sub: SubVolume; iso: number; points: Float32Array; normals: Float32Array; initial: Mat4; startDistance: number }
  | { type: 'distances'; positions: Float32Array; matrix: Mat4; maxDistance: number };

export interface FusionResults {
  phantom: { volume: VolumeData; ios: SurfaceMesh; truth: Mat4; hints: PhantomLandmarkHint[] };
  setDisplayVolume: { ok: true };
  displaySurface: SurfaceMesh;
  register: { matrix: Mat4; summary: IcpSummary; calibratedIso: number | null };
  distances: { distances: Float32Array }; // 无对应面时为 -1
}

export type FusionRequest = FusionTask & { id: number };

export type FusionResponse =
  | { id: number; kind: 'progress'; stage: string; iteration: number; rms: number; inliers: number }
  | { id: number; kind: 'done'; result: FusionResults[keyof FusionResults] }
  | { id: number; kind: 'error'; message: string };
