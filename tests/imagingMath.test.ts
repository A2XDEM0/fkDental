import assert from 'node:assert/strict';
import test from 'node:test';
import { fitRigid, fromAxisAngle, invertRigid, multiply, pairResiduals, rotationAngle, transformPoint } from '../features/imaging/math/rigid.ts';
import { removeSmallComponents, surfaceNets } from '../features/imaging/math/surfaceNets.ts';
import { runIcp } from '../features/imaging/math/icp.ts';
import { calibrateEdgeLevel, createSampler } from '../features/imaging/math/calibrate.ts';
import { computeVertexNormals } from '../features/imaging/view/contours.ts';
import { createSurfaceQuery } from '../features/imaging/math/bvhQuery.ts';
import { extractSubVolume, fullVoxelBox, mmBoxToVoxelBox, smoothSubVolume, suggestThresholds } from '../features/imaging/math/volume.ts';
import { generatePhantom } from '../features/imaging/demo/phantom.ts';

const random = (() => {
  let seed = 7;
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
})();

test('fitRigid 还原已知刚体变换且不产生镜像', () => {
  const truth = fromAxisAngle([0.2, -0.7, 0.4], 1.1, [12, -5, 30]);
  const src: number[] = [];
  const dst: number[] = [];
  for (let i = 0; i < 6; i++) {
    const p = [random() * 40, random() * 40, random() * 10];
    src.push(...p);
    dst.push(...transformPoint(truth, p[0], p[1], p[2]));
  }
  const fit = fitRigid(src, dst);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(fit[i] - truth[i]) < 1e-9, `元素 ${i}`);
  assert.ok(Math.max(...pairResiduals(fit, src, dst)) < 1e-9);
  const round = multiply(fit, invertRigid(fit));
  assert.ok(rotationAngle(round) < 1e-7);
});

test('surfaceNets 生成朝外、闭合且亚体素精度的球面', () => {
  const n = 48;
  const radius = 15.3;
  const data = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    data[i + n * (j + n * k)] = radius - Math.hypot(i - 23.5, j - 23.5, k - 23.5);
  }
  const mesh = surfaceNets(data, [n, n, n], 0);
  const vertexCount = mesh.positions.length / 3;
  const triCount = mesh.indices.length / 3;
  assert.ok(vertexCount > 1000);
  let maxError = 0;
  for (let v = 0; v < vertexCount; v++) {
    const r = Math.hypot(mesh.positions[v * 3] - 23.5, mesh.positions[v * 3 + 1] - 23.5, mesh.positions[v * 3 + 2] - 23.5);
    maxError = Math.max(maxError, Math.abs(r - radius));
  }
  assert.ok(maxError < 0.2, `半径最大误差 ${maxError}`);
  // 闭合流形球面的欧拉示性数为 2
  const edges = new Set<number>();
  let outward = 0;
  for (let t = 0; t < triCount; t++) {
    const idx = [mesh.indices[t * 3], mesh.indices[t * 3 + 1], mesh.indices[t * 3 + 2]];
    for (let e = 0; e < 3; e++) {
      const a = Math.min(idx[e], idx[(e + 1) % 3]), b = Math.max(idx[e], idx[(e + 1) % 3]);
      edges.add(a * vertexCount + b);
    }
    const p = idx.map(v => [mesh.positions[v * 3] - 23.5, mesh.positions[v * 3 + 1] - 23.5, mesh.positions[v * 3 + 2] - 23.5]);
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const normal = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (normal[0] * p[0][0] + normal[1] * p[0][1] + normal[2] * p[0][2] > 0) outward++;
  }
  assert.equal(vertexCount - edges.size + triCount, 2);
  assert.equal(outward, triCount);
});

test('removeSmallComponents 去掉孤立碎片', () => {
  const n = 40;
  const data = new Float32Array(n * n * n);
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const big = 10 - Math.hypot(i - 14, j - 14, k - 14);
    const small = 1.2 - Math.hypot(i - 33, j - 33, k - 33);
    data[i + n * (j + n * k)] = Math.max(big, small);
  }
  const mesh = surfaceNets(data, [n, n, n], 0);
  const cleaned = removeSmallComponents(mesh, 200);
  assert.ok(cleaned.indices.length < mesh.indices.length);
  let maxCoord = 0;
  for (let i = 0; i < cleaned.positions.length; i++) maxCoord = Math.max(maxCoord, cleaned.positions[i]);
  assert.ok(maxCoord < 26);
});

test('演示病例：标记点粗配准 + ICP + 阈值自校准后，目标配准误差小于 0.05 mm', () => {
  const phantom = generatePhantom();
  const { volume, ios, truth, hints } = phantom;
  const thresholds = suggestThresholds(volume);
  assert.ok(thresholds.bone > 100 && thresholds.bone < thresholds.teeth, JSON.stringify(thresholds));
  assert.ok(thresholds.teeth > 1000 && thresholds.teeth < 2600, JSON.stringify(thresholds));

  // 模拟人工点选：给两侧标记点各加约 0.6 mm 的随机偏差。
  const src: number[] = [];
  const dst: number[] = [];
  const jitter = () => (random() - 0.5) * 1.2;
  for (const hint of hints) {
    src.push(hint.ios[0] + jitter(), hint.ios[1] + jitter(), hint.ios[2] + jitter());
    dst.push(hint.ct[0] + jitter(), hint.ct[1] + jitter(), hint.ct[2] + jitter());
  }
  const coarse = fitRigid(src, dst);

  const vertexCount = ios.positions.length / 3;
  const tre = (matrix: ArrayLike<number>) => {
    let sum = 0;
    for (let v = 0; v < vertexCount; v += 7) {
      const a = transformPoint(matrix, ios.positions[v * 3], ios.positions[v * 3 + 1], ios.positions[v * 3 + 2]);
      const b = transformPoint(truth, ios.positions[v * 3], ios.positions[v * 3 + 1], ios.positions[v * 3 + 2]);
      sum += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    }
    return Math.sqrt(sum / Math.ceil(vertexCount / 7));
  };
  const coarseTre = tre(coarse);
  assert.ok(coarseTre > 0.05 && coarseTre < 3, `粗配准 TRE ${coarseTre}`);

  // 粗配准后只在口扫包围盒附近以全分辨率提取 CBCT 牙面。
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexCount; v += 5) {
    const p = transformPoint(coarse, ios.positions[v * 3], ios.positions[v * 3 + 1], ios.positions[v * 3 + 2]);
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  }
  const sub = extractSubVolume(volume, mmBoxToVoxelBox(volume, min, max, 4), 1);
  smoothSubVolume(sub);
  const surface = removeSmallComponents(surfaceNets(sub.data, sub.dims, thresholds.teeth), 60);
  for (let i = 0; i < surface.positions.length; i += 3) {
    surface.positions[i] = sub.origin[0] + surface.positions[i] * sub.spacing[0];
    surface.positions[i + 1] = sub.origin[1] + surface.positions[i + 1] * sub.spacing[1];
    surface.positions[i + 2] = sub.origin[2] + surface.positions[i + 2] * sub.spacing[2];
  }
  const query = createSurfaceQuery(surface.positions, surface.indices);

  const stride = Math.max(1, Math.floor(vertexCount / 15000));
  const sampleCount = Math.ceil(vertexCount / stride);
  const points = new Float32Array(sampleCount * 3);
  const normals = new Float32Array(sampleCount * 3);
  const allNormals = computeVertexNormals(ios);
  for (let i = 0, v = 0; i < sampleCount; i++, v += stride) {
    points.set(ios.positions.subarray(v * 3, v * 3 + 3), i * 3);
    normals.set(allNormals.subarray(v * 3, v * 3 + 3), i * 3);
  }
  const first = runIcp(points, normals, query, { initial: coarse, startDistance: 3 });
  const firstTre = tre(first.matrix);
  assert.ok(first.summary.converged, 'ICP 应当收敛');
  assert.ok(!first.summary.normalsFlipped);
  assert.ok(firstTre < 0.3 && firstTre < coarseTre, `ICP 后 TRE ${firstTre}`);

  // 阈值自校准：估计出的牙冠边缘灰度应接近牙釉质与软组织的中点 (2650 + 40) / 2，与起始阈值无关。
  const level = calibrateEdgeLevel(points, normals, first.matrix, 1, query, createSampler(sub), volume.spacing[0], thresholds.teeth);
  assert.ok(level !== null && Math.abs(level - 1345) < 80, `校准灰度 ${level}`);
  const refined = removeSmallComponents(surfaceNets(sub.data, sub.dims, level), 60);
  for (let i = 0; i < refined.positions.length; i += 3) {
    refined.positions[i] = sub.origin[0] + refined.positions[i] * sub.spacing[0];
    refined.positions[i + 1] = sub.origin[1] + refined.positions[i + 1] * sub.spacing[1];
    refined.positions[i + 2] = sub.origin[2] + refined.positions[i + 2] * sub.spacing[2];
  }
  const second = runIcp(points, normals, createSurfaceQuery(refined.positions, refined.indices), {
    initial: first.matrix, startDistance: 1, minDistance: 0.25, maxIterations: 40
  });
  const finalTre = tre(second.matrix);
  console.log(`  粗配准 TRE ${coarseTre.toFixed(3)} mm -> ICP(阈值 ${thresholds.teeth}) ${firstTre.toFixed(3)} mm -> 校准到 ${level.toFixed(0)} 后 ${finalTre.toFixed(3)} mm；表面偏差中位数 ${second.summary.median.toFixed(3)} mm，内点 ${second.summary.matched}/${second.summary.total}`);
  assert.ok(second.summary.converged);
  assert.ok(finalTre < 0.05, `校准后 TRE ${finalTre}`);
});

test('extractSubVolume 块平均与原点换算', () => {
  const volume = {
    dims: [4, 4, 4] as [number, number, number],
    spacing: [0.5, 0.5, 1] as [number, number, number],
    data: Int16Array.from({ length: 64 }, (_, i) => i),
    toPatient: new Float64Array(16),
    range: [0, 63] as [number, number],
    meta: { source: 'phantom' as const, description: '', warnings: [] }
  };
  const sub = extractSubVolume(volume, fullVoxelBox(volume), 2);
  assert.deepEqual(sub.dims, [2, 2, 2]);
  assert.deepEqual(sub.origin, [0.25, 0.25, 0.5]);
  assert.equal(sub.data[0], (0 + 1 + 4 + 5 + 16 + 17 + 20 + 21) / 8);
});
