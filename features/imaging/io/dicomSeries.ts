import dicomParser from 'dicom-parser';
import type { Vec3, VolumeData } from '../types';
import { identity } from '../math/rigid.ts';
import { computeRange } from '../math/volume.ts';

// 与 File 解耦，便于测试，也允许分两遍读取：第一遍只留元数据，第二遍按层序填充体数据，
// 这样内存峰值约等于一份体数据，而不是“全部文件 + 体数据”。
export interface FileSource {
  name: string;
  read: () => Promise<ArrayBuffer>;
}

export type LoadProgress = (done: number, total: number, stage: string) => void;

// 所选文件里一张 DICOM 图像都没有。调用方可以据此区分“选错了文件”和“序列本身有问题”。
export class NoDicomImagesError extends Error {
  constructor() {
    super('所选文件里没有可识别的 DICOM 图像。');
    this.name = 'NoDicomImagesError';
  }
}

const UNCOMPRESSED_SYNTAXES = new Set([
  '1.2.840.10008.1.2',   // Implicit VR Little Endian
  '1.2.840.10008.1.2.1', // Explicit VR Little Endian
  '1.2.840.10008.1.2.2'  // Explicit VR Big Endian
]);

const SYNTAX_NAMES: Record<string, string> = {
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG Extended',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless (SV1)',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-lossless',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE Lossless'
};

interface FrameRef {
  fileIndex: number;
  frameIndex: number;
  position: Vec3 | null;
  order: number;
}

interface SeriesGroup {
  key: string;
  rows: number;
  cols: number;
  description: string;
  modality: string;
  orientation: number[] | null;
  pixelSpacing: [number, number] | null;
  sliceSpacing: number | null;
  frames: FrameRef[];
}

const parseNumbers = (text: string | undefined) => (text ? text.split('\\').map(Number) : []);

const sequenceItem = (dataSet: dicomParser.DataSet | undefined, tag: string, index = 0) =>
  dataSet?.elements[tag]?.items?.[index]?.dataSet;

const readVec3 = (text: string | undefined): Vec3 | null => {
  const values = parseNumbers(text);
  return values.length >= 3 && values.every(Number.isFinite) ? [values[0], values[1], values[2]] : null;
};

const tryParse = (buffer: ArrayBuffer) => {
  if (buffer.byteLength < 200) return null;
  try {
    return dicomParser.parseDicom(new Uint8Array(buffer));
  } catch {
    return null;
  }
};

export const loadDicomSeries = async (sources: FileSource[], onProgress?: LoadProgress): Promise<VolumeData> => {
  const groups = new Map<string, SeriesGroup>();
  const compressed = new Map<string, number>();
  let parsed = 0;

  for (let fileIndex = 0; fileIndex < sources.length; fileIndex++) {
    onProgress?.(fileIndex, sources.length, '读取 DICOM 头信息');
    if (/^dicomdir$/i.test(sources[fileIndex].name)) continue;
    const dataSet = tryParse(await sources[fileIndex].read());
    if (!dataSet || !dataSet.elements.x7fe00010) continue;
    parsed++;

    const syntax = dataSet.string('x00020010') || '1.2.840.10008.1.2';
    if (!UNCOMPRESSED_SYNTAXES.has(syntax)) {
      compressed.set(syntax, (compressed.get(syntax) || 0) + 1);
      continue;
    }
    const rows = dataSet.uint16('x00280010') || 0;
    const cols = dataSet.uint16('x00280011') || 0;
    const frameCount = Math.max(1, Number(dataSet.intString('x00280008')) || 1);
    if (!rows || !cols) continue;

    const shared = sequenceItem(dataSet, 'x52009229');
    const measures = sequenceItem(shared, 'x00289110');
    const spacingValues = parseNumbers(dataSet.string('x00280030') || measures?.string('x00280030') || dataSet.string('x00181164'));
    const orientationValues = parseNumbers(dataSet.string('x00200037') || sequenceItem(shared, 'x00209116')?.string('x00200037'));
    const sliceSpacing = Number(dataSet.floatString('x00180088') ?? measures?.floatString('x00180088')
      ?? dataSet.floatString('x00180050') ?? measures?.floatString('x00180050'));

    const key = `${dataSet.string('x0020000e') || 'unknown'}|${rows}x${cols}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key, rows, cols,
        description: dataSet.string('x0008103e') || dataSet.string('x00081030') || '',
        modality: dataSet.string('x00080060') || '',
        orientation: orientationValues.length === 6 ? orientationValues : null,
        pixelSpacing: spacingValues.length >= 2 && spacingValues[0] > 0 ? [spacingValues[0], spacingValues[1]] : null,
        sliceSpacing: Number.isFinite(sliceSpacing) && Math.abs(sliceSpacing) > 0 ? Math.abs(sliceSpacing) : null,
        frames: []
      };
      groups.set(key, group);
    }
    const instance = Number(dataSet.intString('x00200013')) || fileIndex;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
      const perFrame = sequenceItem(dataSet, 'x52009230', frameIndex);
      const position = frameCount > 1
        ? readVec3(sequenceItem(perFrame, 'x00209113')?.string('x00200032'))
        : readVec3(dataSet.string('x00200032'));
      group.frames.push({ fileIndex, frameIndex, position, order: instance * 100000 + frameIndex });
    }
    if (fileIndex % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }

  let best: SeriesGroup | null = null;
  for (const group of groups.values()) if (!best || group.frames.length > best.frames.length) best = group;
  if (!best || best.frames.length < 2) {
    if (compressed.size) {
      const names = [...compressed.keys()].map(uid => SYNTAX_NAMES[uid] || uid).join('、');
      throw new Error(`这批 DICOM 使用了压缩传输语法（${names}），当前版本只读取未压缩数据。请在 CBCT 工作站导出时选择“未压缩”，或先用 dcm2niix 转成 NIfTI 再导入。`);
    }
    if (!parsed) throw new NoDicomImagesError();
    throw new Error('没有找到包含两层以上的 CBCT 序列。');
  }

  const warnings: string[] = [];
  if (groups.size > 1) warnings.push(`检测到 ${groups.size} 个序列，已自动选用层数最多的一个（${best.frames.length} 层）。`);
  if (compressed.size) warnings.push('部分文件使用压缩传输语法，已跳过。');

  // 有切片位置时，层序沿 行方向 × 列方向 的法向升序排列，保证体素坐标系是右手系。
  const o = best.orientation || [1, 0, 0, 0, 1, 0];
  if (!best.orientation) warnings.push('缺少 ImageOrientationPatient，已按标准轴位方向处理。');
  const normal: Vec3 = [o[1] * o[5] - o[2] * o[4], o[2] * o[3] - o[0] * o[5], o[0] * o[4] - o[1] * o[3]];
  const project = (p: Vec3) => p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2];
  const hasPositions = best.frames.every(frame => frame.position);
  let frames = best.frames.slice();
  let dz = best.sliceSpacing || 0;
  let orientationUncertain = false;
  if (hasPositions) {
    frames.sort((a, b) => project(a.position!) - project(b.position!));
    frames = frames.filter((frame, i) => i === 0 || project(frame.position!) - project(frames[i - 1].position!) > 1e-4);
    const gaps: number[] = [];
    for (let i = 1; i < frames.length; i++) gaps.push(project(frames[i].position!) - project(frames[i - 1].position!));
    const sorted = gaps.slice().sort((a, b) => a - b);
    dz = sorted[sorted.length >> 1];
    if (sorted[sorted.length - 1] - sorted[0] > 0.05 * dz) warnings.push('层间距不均匀（可能缺层），三维几何精度会受影响。');
  } else {
    // 没有位置就无从判断 InstanceNumber 是沿法向递增还是递减，堆出来的体数据可能是镜像的。
    frames.sort((a, b) => a.order - b.order);
    orientationUncertain = true;
    warnings.push('缺少 ImagePositionPatient，层序只能按 InstanceNumber 排列，无法确认头脚方向：体数据可能是镜像的（左右互换）。用于配准前请在切面上核对左右。');
  }
  if (!(dz > 0)) {
    dz = 1;
    warnings.push('无法确定层间距，已按 1 mm 处理，请核对。');
  }
  if (!best.pixelSpacing) warnings.push('缺少 PixelSpacing，已按 1 mm 处理，请核对。');
  const rowSpacing = best.pixelSpacing?.[0] || 1;
  const colSpacing = best.pixelSpacing?.[1] || 1;

  const nx = best.cols, ny = best.rows, nz = frames.length;
  const frameSize = nx * ny;
  const data = new Int16Array(frameSize * nz);
  const slotsByFile = new Map<number, Array<{ frameIndex: number; slot: number }>>();
  frames.forEach((frame, slot) => {
    const list = slotsByFile.get(frame.fileIndex) || [];
    list.push({ frameIndex: frame.frameIndex, slot });
    slotsByFile.set(frame.fileIndex, list);
  });

  let done = 0;
  for (const [fileIndex, slots] of slotsByFile) {
    onProgress?.(done, slotsByFile.size, '载入体素数据');
    done++;
    const dataSet = tryParse(await sources[fileIndex].read());
    const pixel = dataSet?.elements.x7fe00010;
    if (!dataSet || !pixel) continue;
    const bits = dataSet.uint16('x00280100') || 16;
    const signed = dataSet.uint16('x00280103') === 1;
    const bigEndian = dataSet.string('x00020010') === '1.2.840.10008.1.2.2';
    const transform = sequenceItem(sequenceItem(dataSet, 'x52009229'), 'x00289145');
    const slope = Number(dataSet.floatString('x00281053') ?? transform?.floatString('x00281053') ?? 1) || 1;
    const intercept = Number(dataSet.floatString('x00281052') ?? transform?.floatString('x00281052') ?? 0) || 0;
    const bytesPerFrame = frameSize * (bits / 8);
    for (const { frameIndex, slot } of slots) {
      const start = pixel.dataOffset + frameIndex * bytesPerFrame;
      if (start + bytesPerFrame > dataSet.byteArray.length) continue;
      // 复制一份以保证 16 位视图按偶数字节对齐。
      const bytes = dataSet.byteArray.slice(start, start + bytesPerFrame);
      const target = data.subarray(slot * frameSize, (slot + 1) * frameSize);
      if (bits === 8) {
        for (let i = 0; i < frameSize; i++) target[i] = bytes[i] * slope + intercept;
        continue;
      }
      if (bigEndian) {
        for (let i = 0; i < bytes.length; i += 2) {
          const tmp = bytes[i]; bytes[i] = bytes[i + 1]; bytes[i + 1] = tmp;
        }
      }
      const raw = signed ? new Int16Array(bytes.buffer, 0, frameSize) : new Uint16Array(bytes.buffer, 0, frameSize);
      if (slope === 1 && intercept === 0 && signed) {
        target.set(raw);
      } else {
        for (let i = 0; i < frameSize; i++) {
          const value = raw[i] * slope + intercept;
          target[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
        }
      }
    }
    if (done % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }

  const toPatient = identity();
  toPatient[0] = o[0]; toPatient[1] = o[1]; toPatient[2] = o[2];
  toPatient[4] = o[3]; toPatient[5] = o[4]; toPatient[6] = o[5];
  toPatient[8] = normal[0]; toPatient[9] = normal[1]; toPatient[10] = normal[2];
  const origin = frames[0].position;
  if (origin) { toPatient[12] = origin[0]; toPatient[13] = origin[1]; toPatient[14] = origin[2]; }

  const label = [best.modality, best.description].filter(Boolean).join(' · ');
  return {
    dims: [nx, ny, nz],
    spacing: [colSpacing, rowSpacing, dz],
    data,
    toPatient,
    range: computeRange(data),
    meta: {
      source: 'dicom',
      description: label || 'DICOM 序列',
      warnings,
      orientationUncertain
    }
  };
};
