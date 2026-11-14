export type Vec3 = [number, number, number];

// 4x4 刚体矩阵，列主序，与 three.js Matrix4.elements 的排列一致。
export type Mat4 = Float64Array;

export interface VolumeMeta {
  source: 'dicom' | 'nifti' | 'phantom';
  description: string;
  warnings: string[];
  // 层序方向无法从文件确认（DICOM 缺少切片位置），体数据可能是镜像的。
  orientationUncertain?: boolean;
}

// CBCT 体数据。体素局部坐标以毫米计：x = i * spacing[0]，y = j * spacing[1]，z = k * spacing[2]，
// 应保持右手系，避免配准时出现左右镜像；做不到时 meta.orientationUncertain 为 true。
export interface VolumeData {
  dims: Vec3;
  spacing: Vec3;
  data: Int16Array;
  toPatient: Mat4; // 体素局部毫米坐标 -> DICOM 患者坐标系 (LPS)
  range: [number, number];
  meta: VolumeMeta;
}

export interface SurfaceMesh {
  positions: Float32Array;
  indices: Uint32Array;
  colors?: Float32Array;
}

export interface DeviationStats {
  rms: number;
  mean: number;
  median: number;
  p95: number;
  matched: number; // 参与统计的采样点数
  total: number;
  within02: number; // 偏差 <= 0.2 mm 的占比
  within05: number;
}

export interface IcpSummary extends DeviationStats {
  iterations: number;
  converged: boolean;
  normalsFlipped: boolean;
}
