import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDicomSeries, NoDicomImagesError } from '../features/imaging/io/dicomSeries.ts';
import { loadNifti } from '../features/imaging/io/nifti.ts';
import { loadMeshFile, writeBinaryStl } from '../features/imaging/io/meshFile.ts';
import { fromAxisAngle, transformPoint } from '../features/imaging/math/rigid.ts';

// 测试用的最小 DICOM Part 10 写入器（Explicit VR Little Endian，未压缩）。
const encodeElement = (group: number, element: number, vr: string, value: string | number | Uint8Array) => {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) bytes = value;
  else if (vr === 'US') bytes = new Uint8Array(new Uint16Array([value as number]).buffer);
  else {
    let text = String(value);
    if (text.length % 2) text += vr === 'UI' ? '\0' : ' ';
    bytes = new TextEncoder().encode(text);
  }
  const long = vr === 'OW' || vr === 'OB';
  const out = new Uint8Array((long ? 12 : 8) + bytes.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, group, true);
  view.setUint16(2, element, true);
  out[4] = vr.charCodeAt(0); out[5] = vr.charCodeAt(1);
  if (long) view.setUint32(8, bytes.length, true); else view.setUint16(6, bytes.length, true);
  out.set(bytes, long ? 12 : 8);
  return out;
};

const writeDicom = (options: { instance: number; position: number[] | null; rows: number; cols: number; pixels: Uint16Array; series?: string }) => {
  const parts = [
    new Uint8Array(128),
    new TextEncoder().encode('DICM'),
    encodeElement(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
    encodeElement(0x0008, 0x0060, 'CS', 'CT'),
    encodeElement(0x0008, 0x103e, 'LO', 'CBCT test'),
    encodeElement(0x0020, 0x000e, 'UI', options.series || '1.2.3.4'),
    encodeElement(0x0020, 0x0013, 'IS', options.instance),
    ...(options.position ? [encodeElement(0x0020, 0x0032, 'DS', options.position.join('\\'))] : []),
    encodeElement(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    encodeElement(0x0028, 0x0010, 'US', options.rows),
    encodeElement(0x0028, 0x0011, 'US', options.cols),
    encodeElement(0x0028, 0x0030, 'DS', '0.4\\0.3'),
    encodeElement(0x0028, 0x0100, 'US', 16),
    encodeElement(0x0028, 0x0103, 'US', 0),
    encodeElement(0x0028, 0x1052, 'DS', '-1024'),
    encodeElement(0x0028, 0x1053, 'DS', '1'),
    encodeElement(0x7fe0, 0x0010, 'OW', new Uint8Array(options.pixels.buffer))
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out.buffer;
};

test('loadDicomSeries 按空间位置重排乱序切片并换算 HU', async () => {
  const cols = 6, rows = 5, slices = 4;
  const hu = (i: number, j: number, k: number) => i * 10 + j * 100 + k * 1000 - 500;
  const files = [];
  // 故意按 2,0,3,1 的顺序提供，InstanceNumber 也与空间顺序相反。
  for (const k of [2, 0, 3, 1]) {
    const pixels = new Uint16Array(rows * cols);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) pixels[i + cols * j] = hu(i, j, k) + 1024;
    const buffer = writeDicom({ instance: slices - k, position: [-10, -20, 5 + k * 0.5], rows, cols, pixels });
    files.push({ name: `IM${k}`, read: async () => buffer });
  }
  // 混入一个非 DICOM 文件和一张属于其他序列的定位片
  files.push({ name: 'README.txt', read: async () => new TextEncoder().encode('not dicom'.repeat(40)).buffer as ArrayBuffer });
  const scout = writeDicom({ instance: 1, position: [0, 0, 0], rows: 2, cols: 2, pixels: new Uint16Array(4), series: '9.9.9' });
  files.push({ name: 'scout', read: async () => scout });

  const volume = await loadDicomSeries(files);
  assert.deepEqual(volume.dims, [cols, rows, slices]);
  assert.ok(Math.abs(volume.spacing[0] - 0.3) < 1e-9 && Math.abs(volume.spacing[1] - 0.4) < 1e-9 && Math.abs(volume.spacing[2] - 0.5) < 1e-9);
  for (let k = 0; k < slices; k++) for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    assert.equal(volume.data[i + cols * (j + rows * k)], hu(i, j, k));
  }
  assert.deepEqual(transformPoint(volume.toPatient, 0, 0, 0), [-10, -20, 5]);
  assert.deepEqual(transformPoint(volume.toPatient, 0.3, 0.4, 0.5), [-9.7, -19.6, 5.5]);
  assert.ok(volume.meta.warnings.some(w => w.includes('2 个序列')));
  assert.equal(volume.meta.orientationUncertain, false);
});

test('loadDicomSeries 缺少切片位置时按 InstanceNumber 堆叠并标记方向不可靠', async () => {
  const files = [3, 1, 2].map(instance => {
    const buffer = writeDicom({ instance, position: null, rows: 2, cols: 2, pixels: new Uint16Array(4).fill(1024 + instance) });
    return { name: `IM${instance}`, read: async () => buffer };
  });
  const volume = await loadDicomSeries(files);
  assert.deepEqual([volume.data[0], volume.data[4], volume.data[8]], [1, 2, 3]);
  assert.equal(volume.meta.orientationUncertain, true);
  assert.ok(volume.meta.warnings.some(w => w.includes('镜像')));
});

test('loadDicomSeries 在没有任何 DICOM 图像时抛出 NoDicomImagesError', async () => {
  const junk = new TextEncoder().encode('not dicom'.repeat(40)).buffer as ArrayBuffer;
  await assert.rejects(loadDicomSeries([{ name: 'notes.txt', read: async () => junk }]), NoDicomImagesError);
});

test('loadDicomSeries 对压缩传输语法给出可操作的提示', async () => {
  const buffer = writeDicom({ instance: 1, position: [0, 0, 0], rows: 2, cols: 2, pixels: new Uint16Array(4) });
  const bytes = new Uint8Array(buffer);
  // 把 TransferSyntaxUID 末尾改成 .4.90（JPEG 2000 Lossless）的等长占位
  const text = new TextEncoder().encode('1.2.840.10008.1.2.4.90');
  const patched = new Uint8Array(bytes.length + 2);
  patched.set(bytes.subarray(0, 132));
  patched.set(encodeElement(0x0002, 0x0010, 'UI', new TextDecoder().decode(text)), 132);
  patched.set(bytes.subarray(132 + 8 + 20), 132 + 8 + 22);
  await assert.rejects(
    loadDicomSeries([{ name: 'a', read: async () => patched.buffer }, { name: 'b', read: async () => patched.buffer }]),
    /JPEG 2000 Lossless/
  );
});

test('loadNifti 读取 gzip 压缩体数据并把左手系存储翻成右手系', async () => {
  const nx = 4, ny = 3, nz = 2;
  const buffer = new ArrayBuffer(352 + nx * ny * nz * 2);
  const view = new DataView(buffer);
  view.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((v, i) => view.setInt16(40 + i * 2, v, true));
  view.setInt16(70, 4, true);
  view.setInt16(72, 16, true);
  [1, 0.5, 0.5, 2].forEach((v, i) => view.setFloat32(76 + i * 4, v, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  // sform：体素 x 朝患者左侧的“放射学”存储 (LAS)，是左手系，需要翻转 i 轴
  [-0.5, 0, 0, 10].forEach((v, i) => view.setFloat32(280 + i * 4, v, true));
  [0, 0.5, 0, 20].forEach((v, i) => view.setFloat32(296 + i * 4, v, true));
  [0, 0, 2, 30].forEach((v, i) => view.setFloat32(312 + i * 4, v, true));
  for (let i = 0; i < nx * ny * nz; i++) view.setInt16(352 + i * 2, i, true);

  const gz = await new Response(new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const volume = await loadNifti('test.nii.gz', gz);
  assert.deepEqual(volume.dims, [nx, ny, nz]);
  assert.deepEqual(Array.from(volume.spacing), [0.5, 0.5, 2]);
  // 原始体素 (i,j,k) 的 RAS 坐标是 (10-0.5i, 20+0.5j, 30+2k)，即 LPS (-10+0.5i, -20-0.5j, 30+2k)
  const m = volume.toPatient;
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  assert.ok(Math.abs(det - 1) < 1e-6, `行列式 ${det}`);
  for (const [i, j, k] of [[0, 0, 0], [3, 2, 1], [1, 2, 0]]) {
    const flipped = nx - 1 - i;
    const value = volume.data[flipped + nx * (j + ny * k)];
    assert.equal(value, i + nx * (j + ny * k));
    const p = transformPoint(m, flipped * 0.5, j * 0.5, k * 2);
    assert.ok(Math.hypot(p[0] - (-10 + 0.5 * i), p[1] - (-20 - 0.5 * j), p[2] - (30 + 2 * k)) < 1e-5, p.join(','));
  }
});

test('STL 导出再读回：顶点合并、三角面数与变换后的坐标一致', () => {
  const mesh = {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
    indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2])
  };
  const matrix = fromAxisAngle([0, 0, 1], Math.PI / 2, [5, 0, 0]);
  const loaded = loadMeshFile('scan.STL', writeBinaryStl(mesh, matrix));
  assert.equal(loaded.indices.length, 12);
  assert.equal(loaded.positions.length, 12);
  const found = (target: number[]) => {
    for (let v = 0; v < 4; v++) {
      if (Math.hypot(loaded.positions[v * 3] - target[0], loaded.positions[v * 3 + 1] - target[1], loaded.positions[v * 3 + 2] - target[2]) < 1e-4) return true;
    }
    return false;
  };
  assert.ok(found([5, 0, 0]) && found([5, 10, 0]) && found([-5, 0, 0]) && found([5, 0, 10]));
  assert.throws(() => loadMeshFile('scan.step', new ArrayBuffer(8)), /STL、PLY 或 OBJ/);
});
