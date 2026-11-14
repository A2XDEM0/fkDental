import type { Mat4, SurfaceMesh, Vec3, VolumeData } from '../types';
import { fromAxisAngle, identity, invertRigid, transformPoint } from '../math/rigid.ts';
import { surfaceNets } from '../math/surfaceNets.ts';

// 程序化生成的演示病例：一份合成 CBCT（上下颌牙列 + 颌骨 + 软组织 + 噪声）
// 和一份由同一几何导出的下颌“口扫”网格。口扫被放到任意的扫描仪坐标系里，
// 真值变换已知，可用来演示流程并定量检验配准精度。合成数据不含任何真实患者信息。

export interface PhantomLandmarkHint {
  name: string;
  ios: Vec3;
  ct: Vec3;
}

export interface PhantomCase {
  volume: VolumeData;
  ios: SurfaceMesh;
  truth: Mat4; // 口扫坐标 -> 体素局部坐标
  hints: PhantomLandmarkHint[];
}

export interface PhantomOptions {
  voxel?: number;
  iosVoxel?: number;
  noise?: number;
  seed?: number;
}

type ToothKind = 'incisor' | 'canine' | 'premolar' | 'molar';

interface ToothSpec {
  kind: ToothKind;
  md: number;      // 近远中宽度
  bl: number;      // 颊舌向厚度
  crownH: number;
  rootLen: number;
}

interface Tooth extends ToothSpec {
  cx: number; cy: number;
  zCej: number;
  tx: number; ty: number; // 近远中方向
  bx: number; by: number; // 颊侧方向
  dir: 1 | -1;            // 牙冠朝向：下颌 +z，上颌 -z
  radius: number;
}

const LOWER: ToothSpec[] = [
  { kind: 'incisor', md: 5.3, bl: 5.8, crownH: 8.5, rootLen: 12 },
  { kind: 'incisor', md: 5.9, bl: 6.1, crownH: 8.7, rootLen: 13 },
  { kind: 'canine', md: 6.9, bl: 7.5, crownH: 9.6, rootLen: 15 },
  { kind: 'premolar', md: 7.0, bl: 7.8, crownH: 8.0, rootLen: 13.5 },
  { kind: 'premolar', md: 7.2, bl: 8.2, crownH: 7.6, rootLen: 13.5 },
  { kind: 'molar', md: 10.8, bl: 10.2, crownH: 7.2, rootLen: 12.5 },
  { kind: 'molar', md: 10.2, bl: 9.8, crownH: 6.8, rootLen: 12 }
];

const UPPER: ToothSpec[] = [
  { kind: 'incisor', md: 8.6, bl: 7.0, crownH: 10.5, rootLen: 12.5 },
  { kind: 'incisor', md: 6.6, bl: 6.2, crownH: 9.5, rootLen: 12.5 },
  { kind: 'canine', md: 7.6, bl: 8.0, crownH: 10, rootLen: 13 },
  { kind: 'premolar', md: 7.0, bl: 9.0, crownH: 8.2, rootLen: 12.5 },
  { kind: 'premolar', md: 6.6, bl: 9.0, crownH: 7.5, rootLen: 12.5 },
  { kind: 'molar', md: 10.2, bl: 11.0, crownH: 7.2, rootLen: 12 },
  { kind: 'molar', md: 9.2, bl: 10.8, crownH: 6.8, rootLen: 11.5 }
];

const HU = { air: -1000, soft: 40, cancellous: 380, cortical: 1350, dentin: 1750, enamel: 2650, pulp: 60 };

const LOWER_CEJ = 19.5;
const UPPER_CEJ = 41.5;
const GINGIVA_TOP = 20.3;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const smin = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
};
const sdRoundBox = (x: number, y: number, z: number, bx: number, by: number, bz: number, r: number) => {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
};

const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Arch {
  a: number; b: number; cx: number; y0: number;
  teeth: Tooth[];
  polyline: Float32Array;
}

const buildArch = (a: number, b: number, cx: number, y0: number, specs: ToothSpec[], zCej: number, dir: 1 | -1): Arch => {
  // 半椭圆牙弓，按弧长把牙齿依次排开。
  const steps = 720;
  const thetaMax = Math.PI * 0.5;
  const theta = new Float64Array(steps + 1);
  const length = new Float64Array(steps + 1);
  for (let i = 1; i <= steps; i++) {
    theta[i] = (i / steps) * thetaMax;
    const dx = a * (Math.sin(theta[i]) - Math.sin(theta[i - 1]));
    const dy = b * (Math.cos(theta[i - 1]) - Math.cos(theta[i]));
    length[i] = length[i - 1] + Math.hypot(dx, dy);
  }
  const thetaAt = (arc: number) => {
    let i = 1;
    while (i < steps && length[i] < arc) i++;
    const f = (arc - length[i - 1]) / Math.max(1e-9, length[i] - length[i - 1]);
    return lerp(theta[i - 1], theta[i], clamp01(f));
  };

  const teeth: Tooth[] = [];
  for (const side of [1, -1] as const) {
    let arc = 0;
    for (const spec of specs) {
      const th = thetaAt(arc + spec.md / 2);
      arc += spec.md;
      let tx = side * a * Math.cos(th);
      let ty = b * Math.sin(th);
      const len = Math.hypot(tx, ty);
      tx /= len; ty /= len;
      teeth.push({
        ...spec,
        cx: cx + side * a * Math.sin(th),
        cy: y0 + b * (1 - Math.cos(th)),
        zCej,
        tx, ty,
        bx: side * ty, by: -side * tx,
        dir,
        radius: Math.hypot(spec.md, spec.bl) / 2 + 1.6
      });
    }
  }

  const total = specs.reduce((sum, spec) => sum + spec.md, 0) + 1.5;
  const count = Math.ceil((total * 2) / 0.25);
  const polyline = new Float32Array((count + 1) * 2);
  for (let i = 0; i <= count; i++) {
    const arc = -total + (2 * total * i) / count;
    const th = thetaAt(Math.abs(arc));
    polyline[i * 2] = cx + Math.sign(arc) * a * Math.sin(th);
    polyline[i * 2 + 1] = y0 + b * (1 - Math.cos(th));
  }
  return { a, b, cx, y0, teeth, polyline };
};

const distanceToPolyline = (polyline: Float32Array, x: number, y: number) => {
  let best = Infinity;
  for (let i = 0; i < polyline.length; i += 2) {
    const dx = polyline[i] - x, dy = polyline[i + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
};

// 牙齿隐式函数的输出放在模块级变量里，避免逐体素分配对象。
let outTooth = 0;
let outCrown = 0;
let outH = 0;
let outPulp = false;

const evalTooth = (tooth: Tooth, x: number, y: number, z: number) => {
  const px = x - tooth.cx, py = y - tooth.cy;
  const u = px * tooth.tx + py * tooth.ty;
  const v = px * tooth.bx + py * tooth.by;
  const h = tooth.dir * (z - tooth.zCej);
  const H = tooth.crownH;
  const s = clamp01(h / H);
  const neck = lerp(0.84, 1, smoothstep(0, 0.4, s));

  let crown: number;
  if (tooth.kind === 'incisor') {
    const us = neck;
    const vs = neck * lerp(1, 0.3, smoothstep(0.2, 1, s));
    crown = sdRoundBox(u / us, v / vs, h - H / 2, tooth.md / 2, tooth.bl / 2, H / 2, 1.1) * Math.min(us, vs);
  } else if (tooth.kind === 'canine') {
    const us = neck * lerp(1, 0.38, smoothstep(0.5, 1, s));
    const vs = neck * lerp(1, 0.42, smoothstep(0.4, 1, s));
    crown = sdRoundBox(u / us, v / vs, h - H / 2, tooth.md / 2, tooth.bl / 2, H / 2, 1.7) * Math.min(us, vs);
  } else if (tooth.kind === 'premolar') {
    const bodyH = H - 0.9;
    crown = sdRoundBox(u / neck, v / neck, h - bodyH / 2, tooth.md / 2, tooth.bl / 2, bodyH / 2, 2.1) * neck;
    const cv = tooth.bl * 0.23;
    crown = smin(crown, Math.hypot(u, v - cv, h - (H - 1.7)) - 1.7, 0.8);
    crown = smin(crown, Math.hypot(u, v + cv, h - (H - 2.3)) - 1.5, 0.8);
  } else {
    const bodyH = H - 1;
    crown = sdRoundBox(u / neck, v / neck, h - bodyH / 2, tooth.md / 2, tooth.bl / 2, bodyH / 2, 2.3) * neck;
    const cu = tooth.md * 0.24, cv = tooth.bl * 0.24;
    for (let i = 0; i < 4; i++) {
      const du = i & 1 ? cu : -cu;
      const dv = i & 2 ? cv : -cv;
      crown = smin(crown, Math.hypot(u - du, v - dv, h - (H - 1.7)) - 1.7, 0.9);
    }
  }

  const tau = clamp01((1 - h) / (1 + tooth.rootLen));
  let root: number;
  let axis: number;
  if (tooth.kind === 'molar') {
    const r = lerp(tooth.md * 0.2, 0.7, tau);
    const hc = Math.max(-tooth.rootLen + 0.7, Math.min(1, h));
    const offset = tooth.md * 0.23 + 0.7 * tau;
    const a1 = Math.hypot(u - offset, v);
    const a2 = Math.hypot(u + offset, v);
    axis = Math.min(a1, a2);
    root = Math.min(Math.hypot(a1, h - hc), Math.hypot(a2, h - hc)) - r;
  } else {
    const r = lerp(Math.min(tooth.md, tooth.bl) * 0.37, 0.7, tau);
    const hc = Math.max(-tooth.rootLen + 0.7, Math.min(1, h));
    axis = Math.hypot(u, v);
    root = Math.hypot(axis, h - hc) - r;
  }

  outCrown = crown;
  outH = h;
  outTooth = smin(crown, root, 0.6);
  outPulp = h > -tooth.rootLen + 2.5 && h < H * 0.42 && axis < 0.85 - 0.45 * tau;
};

const gingivaField = (rho: number, z: number) => {
  const r = 3;
  const qx = rho - 7.1 + r;
  const qz = z - GINGIVA_TOP + r;
  const ox = Math.max(qx, 0), oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - r;
};

const tubeField = (rho: number, z: number, zc: number, hz: number, halfWidth: number) => {
  const nx = rho / halfWidth, nz = (z - zc) / hz;
  return (Math.sqrt(nx * nx + nz * nz) - 1) * Math.min(halfWidth, hz);
};

export const generatePhantom = (options: PhantomOptions = {}): PhantomCase => {
  const voxel = options.voxel ?? 0.35;
  const iosVoxel = options.iosVoxel ?? 0.2;
  const noise = options.noise ?? 55;
  const random = mulberry32(options.seed ?? 20260821);
  const gaussian = () => {
    const u = Math.max(random(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  };

  const size: Vec3 = [89.6, 89.6, 56];
  const dims: Vec3 = [Math.round(size[0] / voxel), Math.round(size[1] / voxel), Math.round(size[2] / voxel)];
  const [nx, ny, nz] = dims;
  const cx = size[0] / 2;
  const lower = buildArch(26, 46, cx, 14, LOWER, LOWER_CEJ, 1);
  const upper = buildArch(28.5, 49, cx, 12, UPPER, UPPER_CEJ, -1);

  // ---- 合成 CBCT ----
  const hu = new Float32Array(nx * ny * nz);
  const rhoLower = new Float32Array(nx * ny);
  const rhoUpper = new Float32Array(nx * ny);
  const column = new Uint8Array(nx * ny); // bit0: 面部轮廓内；bit1: 牙弓内侧
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * voxel, y = j * voxel;
      const c = i + nx * j;
      rhoLower[c] = distanceToPolyline(lower.polyline, x, y);
      rhoUpper[c] = distanceToPolyline(upper.polyline, x, y);
      const fx = (x - cx) / 47, fy = (y - 52) / 46;
      let flags = fx * fx + fy * fy < 1 ? 1 : 0;
      const ax = (x - upper.cx) / upper.a;
      const ay = (y - (upper.y0 + upper.b)) / upper.b;
      if (Math.abs(ax) < 1 && (ay >= 0 || ax * ax + ay * ay < 1)) flags |= 2;
      column[c] = flags;
    }
  }
  const cover = (d: number) => clamp01(0.5 - d / voxel);
  for (let k = 0; k < nz; k++) {
    const z = k * voxel;
    for (let j = 0; j < ny; j++) {
      const y = j * voxel;
      for (let i = 0; i < nx; i++) {
        const c = i + nx * j;
        const x = i * voxel;
        let value = column[c] & 1 ? HU.soft : HU.air;
        // 舌背与腭之间的口腔气腔
        const ox = (x - cx) / 17, oy = (y - 40) / 20, oz = (z - 35) / 7.5;
        value = lerp(value, HU.air, cover((Math.sqrt(ox * ox + oy * oy + oz * oz) - 1) * 7.5));

        const mandible = tubeField(rhoLower[c], z, 8.5, 10, 6.5);
        const maxilla = tubeField(rhoUpper[c], z, 52, 9.5, 6.5);
        let bone = Math.min(mandible, maxilla);
        if (column[c] & 2) bone = Math.min(bone, Math.abs(z - 48.2) - 1.3);
        if (bone < voxel) {
          value = lerp(value, HU.cortical, cover(bone));
          value = lerp(value, HU.cancellous, cover(bone + 1.8));
        }
        hu[c + nx * ny * k] = value;
      }
    }
  }
  for (const tooth of [...lower.teeth, ...upper.teeth]) {
    const zTip = tooth.zCej + tooth.dir * (tooth.crownH + 1);
    const zApex = tooth.zCej - tooth.dir * (tooth.rootLen + 1);
    const i0 = Math.max(0, Math.floor((tooth.cx - tooth.radius) / voxel)), i1 = Math.min(nx - 1, Math.ceil((tooth.cx + tooth.radius) / voxel));
    const j0 = Math.max(0, Math.floor((tooth.cy - tooth.radius) / voxel)), j1 = Math.min(ny - 1, Math.ceil((tooth.cy + tooth.radius) / voxel));
    const k0 = Math.max(0, Math.floor(Math.min(zTip, zApex) / voxel)), k1 = Math.min(nz - 1, Math.ceil(Math.max(zTip, zApex) / voxel));
    for (let k = k0; k <= k1; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          evalTooth(tooth, i * voxel, j * voxel, k * voxel);
          if (outTooth >= voxel) continue;
          const index = i + nx * (j + ny * k);
          let value = lerp(hu[index], HU.enamel, cover(outTooth));
          // 牙釉质只包在牙冠外层约 1.2 mm，牙冠内部和整个牙根为牙本质。
          const dentin = outH < 0 ? outTooth : Math.max(outTooth, outCrown + 1.2);
          value = lerp(value, HU.dentin, cover(dentin));
          if (outPulp) value = lerp(value, HU.pulp, 0.85);
          hu[index] = value;
        }
      }
    }
  }
  const data = new Int16Array(hu.length);
  for (let i = 0; i < hu.length; i++) data[i] = Math.round(hu[i] + noise * gaussian());

  const volume: VolumeData = {
    dims,
    spacing: [voxel, voxel, voxel],
    data,
    toPatient: identity(),
    range: [-1000 - 4 * noise, HU.enamel + 4 * noise],
    meta: {
      source: 'phantom',
      description: `合成演示体数据 ${nx}×${ny}×${nz} @ ${voxel} mm`,
      warnings: []
    }
  };

  // ---- 合成口扫（下颌牙冠 + 牙龈，底部开口）----
  const origin: Vec3 = [cx - 36, lower.y0 - 8, 15.6];
  const gdims: Vec3 = [Math.round(72 / iosVoxel), Math.round((lower.b + 15) / iosVoxel), Math.round(15.6 / iosVoxel)];
  const [gx, gy, gz] = gdims;
  const field = new Float32Array(gx * gy * gz);
  const toothField = new Float32Array(gx * gy * gz).fill(10);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const rho = distanceToPolyline(lower.polyline, origin[0] + i * iosVoxel, origin[1] + j * iosVoxel);
      for (let k = 0; k < gz; k++) field[i + gx * (j + gy * k)] = gingivaField(rho, origin[2] + k * iosVoxel);
    }
  }
  for (const tooth of lower.teeth) {
    const i0 = Math.max(0, Math.floor((tooth.cx - tooth.radius - origin[0]) / iosVoxel)), i1 = Math.min(gx - 1, Math.ceil((tooth.cx + tooth.radius - origin[0]) / iosVoxel));
    const j0 = Math.max(0, Math.floor((tooth.cy - tooth.radius - origin[1]) / iosVoxel)), j1 = Math.min(gy - 1, Math.ceil((tooth.cy + tooth.radius - origin[1]) / iosVoxel));
    for (let k = 0; k < gz; k++) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          evalTooth(tooth, origin[0] + i * iosVoxel, origin[1] + j * iosVoxel, origin[2] + k * iosVoxel);
          const index = i + gx * (j + gy * k);
          if (outTooth < toothField[index]) toothField[index] = outTooth;
        }
      }
    }
  }
  for (let i = 0; i < field.length; i++) field[i] = -smin(field[i], toothField[i], 0.5);

  const mesh = surfaceNets(field, gdims, 0);
  const vertexCount = mesh.positions.length / 3;
  const colors = new Float32Array(vertexCount * 3);
  const enamelColor = [0.93, 0.9, 0.82];
  const gingivaColor = [0.86, 0.5, 0.5];
  for (let v = 0; v < vertexCount; v++) {
    const ix = mesh.positions[v * 3], iy = mesh.positions[v * 3 + 1], iz = mesh.positions[v * 3 + 2];
    const x = origin[0] + ix * iosVoxel, y = origin[1] + iy * iosVoxel, z = origin[2] + iz * iosVoxel;
    const gi = Math.min(gx - 1, Math.round(ix)), gj = Math.min(gy - 1, Math.round(iy)), gk = Math.min(gz - 1, Math.round(iz));
    const toothValue = toothField[gi + gx * (gj + gy * gk)];
    const gingiva = gingivaField(distanceToPolyline(lower.polyline, x, y), z);
    const mix = smoothstep(-0.25, 0.25, gingiva - toothValue);
    for (let c = 0; c < 3; c++) colors[v * 3 + c] = lerp(gingivaColor[c], enamelColor[c], mix);
    mesh.positions[v * 3] = x + 0.015 * gaussian();
    mesh.positions[v * 3 + 1] = y + 0.015 * gaussian();
    mesh.positions[v * 3 + 2] = z + 0.015 * gaussian();
  }

  // 参考标记点：解析位置吸附到最近的网格顶点上。
  const cuspPoint = (tooth: Tooth, uFrac: number, vFrac: number): Vec3 => [
    tooth.cx + tooth.tx * tooth.md * uFrac + tooth.bx * tooth.bl * vFrac,
    tooth.cy + tooth.ty * tooth.md * uFrac + tooth.by * tooth.bl * vFrac,
    tooth.zCej + tooth.crownH
  ];
  const snap = (p: Vec3): Vec3 => {
    let best = 0, bestD = Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const dx = mesh.positions[v * 3] - p[0], dy = mesh.positions[v * 3 + 1] - p[1], dz = mesh.positions[v * 3 + 2] - p[2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bestD) { bestD = d; best = v; }
    }
    return [mesh.positions[best * 3], mesh.positions[best * 3 + 1], mesh.positions[best * 3 + 2]];
  };
  // LPS 坐标系里 +x 指向患者左侧，buildArch 先排 +x 一侧。
  const left = lower.teeth.slice(0, 7);
  const right = lower.teeth.slice(7);
  const hintPoints: Array<[string, Vec3]> = [
    ['右侧第一磨牙近中颊尖', snap(cuspPoint(right[5], -0.24, 0.24))],
    ['右侧尖牙牙尖', snap(cuspPoint(right[2], 0, 0))],
    ['下中切牙切缘中点', snap([lower.cx, lower.y0, LOWER_CEJ + LOWER[0].crownH])],
    ['左侧尖牙牙尖', snap(cuspPoint(left[2], 0, 0))],
    ['左侧第一磨牙近中颊尖', snap(cuspPoint(left[5], -0.24, 0.24))]
  ];

  // 把口扫放进一个任意的“扫描仪坐标系”。
  let mx = 0, my = 0, mz = 0;
  for (let v = 0; v < vertexCount; v++) {
    mx += mesh.positions[v * 3]; my += mesh.positions[v * 3 + 1]; mz += mesh.positions[v * 3 + 2];
  }
  mx /= vertexCount; my /= vertexCount; mz /= vertexCount;
  const scanner = fromAxisAngle([0.35, -0.5, 0.8], (38 * Math.PI) / 180);
  const offset = transformPoint(scanner, -mx, -my, -mz);
  scanner[12] = offset[0] + 4; scanner[13] = offset[1] - 6; scanner[14] = offset[2] + 9;
  for (let v = 0; v < vertexCount; v++) {
    const p = transformPoint(scanner, mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
    mesh.positions[v * 3] = p[0]; mesh.positions[v * 3 + 1] = p[1]; mesh.positions[v * 3 + 2] = p[2];
  }

  return {
    volume,
    ios: { positions: mesh.positions, indices: mesh.indices, colors },
    truth: invertRigid(scanner),
    hints: hintPoints.map(([name, ct]) => ({ name, ct, ios: transformPoint(scanner, ct[0], ct[1], ct[2]) }))
  };
};
