import type { Vec3, VolumeData } from '../types';
import { fromQuaternion, identity } from '../math/rigid.ts';
import { computeRange } from '../math/volume.ts';

const gunzip = async (buffer: ArrayBuffer) => {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
};

// 读取 NIfTI-1（.nii / .nii.gz）。dcm2niix、3D Slicer 等工具都能把压缩 DICOM 转成这种格式。
export const loadNifti = async (name: string, input: ArrayBuffer): Promise<VolumeData> => {
  const head = new Uint8Array(input, 0, 2);
  const buffer = head[0] === 0x1f && head[1] === 0x8b ? await gunzip(input) : input;
  const view = new DataView(buffer);
  let little = true;
  if (view.getInt32(0, true) !== 348) {
    if (view.getInt32(0, false) !== 348) throw new Error(`${name} 不是 NIfTI-1 文件（暂不支持 NIfTI-2）。`);
    little = false;
  }
  const nx = view.getInt16(42, little), ny = view.getInt16(44, little), nz = view.getInt16(46, little);
  if (view.getInt16(40, little) < 3 || nx < 2 || ny < 2 || nz < 2) throw new Error(`${name} 不是三维体数据。`);
  const datatype = view.getInt16(70, little);
  const pixdim = [0, 1, 2, 3].map(i => view.getFloat32(76 + i * 4, little));
  const offset = Math.round(view.getFloat32(108, little)) || 352;
  const slope = view.getFloat32(112, little) || 1;
  const inter = view.getFloat32(116, little) || 0;

  const readers: Record<number, [number, (o: number) => number]> = {
    2: [1, o => view.getUint8(o)],
    4: [2, o => view.getInt16(o, little)],
    8: [4, o => view.getInt32(o, little)],
    16: [4, o => view.getFloat32(o, little)],
    64: [8, o => view.getFloat64(o, little)],
    256: [1, o => view.getInt8(o)],
    512: [2, o => view.getUint16(o, little)],
    768: [4, o => view.getUint32(o, little)]
  };
  const reader = readers[datatype];
  if (!reader) throw new Error(`${name} 的数据类型 (${datatype}) 暂不支持。`);
  const [bytes, read] = reader;
  const total = nx * ny * nz;
  if (offset + total * bytes > buffer.byteLength) throw new Error(`${name} 文件不完整。`);

  // 体素索引 -> RAS 毫米坐标的三列方向与原点。
  let columns: Vec3[];
  let origin: Vec3;
  if (view.getInt16(254, little) > 0) {
    const row = (base: number) => [0, 1, 2, 3].map(i => view.getFloat32(base + i * 4, little));
    const rx = row(280), ry = row(296), rz = row(312);
    columns = [[rx[0], ry[0], rz[0]], [rx[1], ry[1], rz[1]], [rx[2], ry[2], rz[2]]];
    origin = [rx[3], ry[3], rz[3]];
  } else if (view.getInt16(252, little) > 0) {
    const b = view.getFloat32(256, little), c = view.getFloat32(260, little), d = view.getFloat32(264, little);
    const r = fromQuaternion(Math.sqrt(Math.max(0, 1 - b * b - c * c - d * d)), b, c, d);
    const qfac = pixdim[0] < 0 ? -1 : 1;
    columns = [
      [r[0] * pixdim[1], r[1] * pixdim[1], r[2] * pixdim[1]],
      [r[4] * pixdim[2], r[5] * pixdim[2], r[6] * pixdim[2]],
      [r[8] * pixdim[3] * qfac, r[9] * pixdim[3] * qfac, r[10] * pixdim[3] * qfac]
    ];
    origin = [view.getFloat32(268, little), view.getFloat32(272, little), view.getFloat32(276, little)];
  } else {
    columns = [[pixdim[1] || 1, 0, 0], [0, pixdim[2] || 1, 0], [0, 0, pixdim[3] || 1]];
    origin = [0, 0, 0];
  }
  // RAS -> LPS
  for (const column of [...columns, origin]) { column[0] = -column[0]; column[1] = -column[1]; }
  const spacing = columns.map(column => Math.hypot(column[0], column[1], column[2]) || 1) as Vec3;
  const dirs = columns.map((column, a) => column.map(v => v / spacing[a]) as Vec3);

  const data = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const value = read(offset + i * bytes) * slope + inter;
    data[i] = Number.isFinite(value) ? (value > 32767 ? 32767 : value < -32768 ? -32768 : value) : -1024;
  }

  // 左手系存储（行列式为负）时翻转 i 轴，使体素坐标系保持右手系。
  const det = dirs[0][0] * (dirs[1][1] * dirs[2][2] - dirs[1][2] * dirs[2][1])
    - dirs[0][1] * (dirs[1][0] * dirs[2][2] - dirs[1][2] * dirs[2][0])
    + dirs[0][2] * (dirs[1][0] * dirs[2][1] - dirs[1][1] * dirs[2][0]);
  if (det < 0) {
    for (let row = 0; row < ny * nz; row++) data.subarray(row * nx, (row + 1) * nx).reverse();
    for (let a = 0; a < 3; a++) {
      origin[a] += columns[0][a] * (nx - 1);
      dirs[0][a] = -dirs[0][a];
    }
  }

  const toPatient = identity();
  for (let a = 0; a < 3; a++) {
    toPatient[a * 4] = dirs[a][0]; toPatient[a * 4 + 1] = dirs[a][1]; toPatient[a * 4 + 2] = dirs[a][2];
    toPatient[12 + a] = origin[a];
  }
  return {
    dims: [nx, ny, nz],
    spacing,
    data,
    toPatient,
    range: computeRange(data),
    meta: { source: 'nifti', description: name, warnings: [] }
  };
};
