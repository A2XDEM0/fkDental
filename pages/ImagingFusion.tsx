import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Box, Check, Crosshair, Download, Eye, EyeOff, FileUp, FolderOpen, Layers, Loader2,
  Maximize2, Minimize2, MousePointerClick, RotateCcw, Scan, Sparkles, Trash2, Undo2, Wand2
} from 'lucide-react';
import type { PhantomLandmarkHint } from '../features/imaging/demo/phantom';
import { loadDicomSeries, NoDicomImagesError } from '../features/imaging/io/dicomSeries';
import { loadMeshFile, writeBinaryStl } from '../features/imaging/io/meshFile';
import { loadNifti } from '../features/imaging/io/nifti';
import { fitRigid, multiply, pairResiduals, rootMeanSquare, transformPoint } from '../features/imaging/math/rigid';
import { chooseSurfaceStep, extractSubVolume, fullVoxelBox, mmBoxToVoxelBox, smoothSubVolume, suggestThresholds } from '../features/imaging/math/volume';
import type { IcpSummary, Mat4, SurfaceMesh, Vec3, VolumeData } from '../features/imaging/types';
import {
  CT_COLOR, DEVIATION_MAX_MM, DEVIATION_NONE, DEVIATION_RAMP, IOS_COLOR, IOS_STONE_COLOR, LANDMARK_COLORS, MAX_LANDMARKS,
  deviationToColors, srgbArrayToLinear
} from '../features/imaging/ui/palette';
import { computeVertexNormals, sliceContour, SliceAxis, transformPositions } from '../features/imaging/view/contours';
import { SliceView } from '../features/imaging/view/SliceView';
import { Viewport3D, ViewPreset } from '../features/imaging/view/Viewport3D';
import { FusionWorkerClient } from '../features/imaging/worker/client';

interface CtState {
  volume: VolumeData;
  name: string;
  thresholds: { bone: number; teeth: number };
}

interface IosState {
  mesh: SurfaceMesh;
  normals: Float32Array;
  name: string;
  size: Vec3;
}

interface Registration {
  matrix: Mat4;
  stage: 'landmark' | 'icp';
  residuals: number[];
  landmarkRms: number;
  icp?: IcpSummary;
  icpThreshold?: number; // ICP 最终采用的牙面等值
  calibrated?: boolean;
}

interface DemoInfo {
  truth: Mat4;
  hints: PhantomLandmarkHint[];
}

type PaneKey = 'ios' | 'ct' | 'axial' | 'coronal' | 'sagittal';

const MESH_EXTENSIONS = /\.(stl|ply|obj)$/i;
const NIFTI_EXTENSIONS = /\.nii(\.gz)?$/i;
const SLICE_PANES: Array<{ key: PaneKey; axis: SliceAxis; title: string }> = [
  { key: 'axial', axis: 2, title: '轴位' },
  { key: 'coronal', axis: 1, title: '冠状位' },
  { key: 'sagittal', axis: 0, title: '矢状位' }
];
const VIEW_PRESETS: Array<{ key: ViewPreset; label: string }> = [
  { key: 'front', label: '前' },
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'right', label: '右' },
  { key: 'left', label: '左' }
];

const pause = (ms = 30) => new Promise<void>(resolve => setTimeout(resolve, ms));
const formatMm = (value: number, digits = 2) => `${value.toFixed(digits)} mm`;
const flatten = (points: Vec3[], count: number) => points.slice(0, count).flat();

const collectDroppedFiles = async (items: DataTransferItemList) => {
  const entries = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter((entry): entry is FileSystemEntry => !!entry);
  const files: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const child of batch) await walk(child);
    }
  };
  for (const entry of entries) await walk(entry);
  return files;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

const toRows = (m: ArrayLike<number>) => [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => Number(m[c * 4 + r].toFixed(6))));

const fitQuality = (summary: IcpSummary) => {
  if (summary.matched < summary.total * 0.12) return { tone: 'warn', label: '有效对应面偏少，请检查阈值和粗配准' } as const;
  if (summary.median <= 0.15) return { tone: 'good', label: '贴合良好' } as const;
  if (summary.median <= 0.3) return { tone: 'ok', label: '可接受，建议逐牙核验' } as const;
  return { tone: 'warn', label: '偏差偏大，请调整后重试' } as const;
};

export const ImagingFusion = () => {
  const [ct, setCt] = useState<CtState | null>(null);
  const [threshold, setThreshold] = useState(1200);
  const [ctTriangles, setCtTriangles] = useState(0);
  const [ios, setIos] = useState<IosState | null>(null);
  const [iosPoints, setIosPoints] = useState<Vec3[]>([]);
  const [ctPoints, setCtPoints] = useState<Vec3[]>([]);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [deviation, setDeviation] = useState<Float32Array | null>(null);
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  const [cursor, setCursor] = useState<Vec3>([0, 0, 0]);
  const [windowLevel, setWindowLevel] = useState({ center: 800, width: 4000 });
  const [pickMode, setPickMode] = useState(true);
  const [display, setDisplay] = useState({ ctOpacity: 1, overlay: true, heatmap: true });
  const [busy, setBusy] = useState<{ label: string; progress?: number } | null>(null);
  const [error, setError] = useState('');
  const [maximized, setMaximized] = useState<PaneKey | null>(null);
  const [dragging, setDragging] = useState(false);

  const iosContainer = useRef<HTMLDivElement>(null);
  const ctContainer = useRef<HTMLDivElement>(null);
  const iosView = useRef<Viewport3D | null>(null);
  const ctView = useRef<Viewport3D | null>(null);
  const worker = useRef<FusionWorkerClient | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const ctFileInput = useRef<HTMLInputElement>(null);
  const iosFileInput = useRef<HTMLInputElement>(null);
  const surfaceToken = useRef(0);
  const pendingCtFit = useRef(false);
  const taskRunning = useRef(false);
  const registrationEpoch = useRef(0);
  const dragDepth = useRef(0);
  const displayRef = useRef(display);
  displayRef.current = display;

  const pairCount = Math.min(iosPoints.length, ctPoints.length);
  const ready = !!ct && !!ios;

  // ---- 生命周期：计算线程与两个三维视口 ----
  useEffect(() => {
    const client = new FusionWorkerClient();
    worker.current = client;
    return () => client.dispose();
  }, []);

  useEffect(() => {
    const left = new Viewport3D(iosContainer.current!);
    let right: Viewport3D;
    try {
      right = new Viewport3D(ctContainer.current!);
    } catch (reason) {
      left.dispose();
      throw reason;
    }
    iosView.current = left;
    ctView.current = right;
    return () => {
      left.dispose();
      right.dispose();
      iosView.current = null;
      ctView.current = null;
    };
  }, []);

  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, []);

  // 同一时间只跑一个任务；进行中再触发的载入或配准直接忽略。
  const guarded = useCallback(async (label: string, task: () => Promise<void>) => {
    if (taskRunning.current) return;
    taskRunning.current = true;
    setError('');
    setBusy({ label });
    await pause();
    try {
      await task();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      taskRunning.current = false;
      setBusy(null);
    }
  }, []);

  // 数据或标记点一变，已有的配准结果就作废；epoch 让还在途中的 ICP 知道自己的结果已经过期。
  const clearRegistration = useCallback(() => {
    registrationEpoch.current++;
    setRegistration(null);
    setDeviation(null);
  }, []);

  // ---- 数据载入 ----
  const acceptVolume = useCallback(async (volume: VolumeData, name: string) => {
    const thresholds = suggestThresholds(volume);
    const step = chooseSurfaceStep(volume);
    const sub = extractSubVolume(volume, fullVoxelBox(volume), step);
    if (step === 1) smoothSubVolume(sub);
    await worker.current!.run({ type: 'setDisplayVolume', sub }, [sub.data.buffer]);
    pendingCtFit.current = true;
    setCt({ volume, name, thresholds });
    setThreshold(thresholds.teeth);
    setWindowLevel({ center: Math.round(thresholds.teeth * 0.55), width: Math.round(2.2 * (thresholds.teeth + 300)) });
    setCursor([0, 1, 2].map(a => ((volume.dims[a] - 1) * volume.spacing[a]) / 2) as Vec3);
    setCtPoints([]);
    clearRegistration();
  }, [clearRegistration]);

  const acceptMesh = useCallback((mesh: SurfaceMesh, name: string) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
      max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
    }
    setIos({ mesh, normals: computeVertexNormals(mesh), name, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] });
    setIosPoints([]);
    clearRegistration();
  }, [clearRegistration]);

  const handleFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    const meshFile = files.find(file => MESH_EXTENSIONS.test(file.name));
    const niftiFile = files.find(file => NIFTI_EXTENSIONS.test(file.name));
    const dicomFiles = files.filter(file => !file.name.startsWith('.') && !MESH_EXTENSIONS.test(file.name) && !NIFTI_EXTENSIONS.test(file.name));
    void guarded('正在读取文件', async () => {
      if (meshFile) {
        setBusy({ label: `正在读取口扫模型 ${meshFile.name}` });
        await pause();
        acceptMesh(loadMeshFile(meshFile.name, await meshFile.arrayBuffer()), meshFile.name);
        setDemo(null);
      }
      if (niftiFile) {
        setBusy({ label: `正在读取 ${niftiFile.name}` });
        await pause();
        await acceptVolume(await loadNifti(niftiFile.name, await niftiFile.arrayBuffer()), niftiFile.name);
        setDemo(null);
      } else if (dicomFiles.length) {
        let volume: VolumeData;
        try {
          volume = await loadDicomSeries(
            dicomFiles.map(file => ({ name: file.name, read: () => file.arrayBuffer() })),
            (done, total, stage) => setBusy({ label: `${stage} ${done + 1} / ${total}`, progress: (done + 1) / total })
          );
        } catch (reason) {
          // 口扫文件夹里常夹带说明、缩略图等杂项文件，模型已经载入时不必为它们报错。
          if (meshFile && reason instanceof NoDicomImagesError) return;
          throw reason;
        }
        const folder = (dicomFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath?.split('/')[0];
        await acceptVolume(volume, folder || `${dicomFiles.length} 个 DICOM 文件`);
        setDemo(null);
      }
    });
  }, [acceptMesh, acceptVolume, guarded]);

  const loadDemo = () => guarded('正在生成合成演示病例', async () => {
    const result = await worker.current!.run({ type: 'phantom' });
    await acceptVolume(result.volume, '合成演示病例');
    acceptMesh({ ...result.ios, colors: result.ios.colors && srgbArrayToLinear(result.ios.colors) }, '下颌口扫（合成）');
    setDemo({ truth: result.truth, hints: result.hints });
    setPickMode(true);
  });

  const resetAll = () => {
    setCt(null);
    setIos(null);
    setIosPoints([]);
    setCtPoints([]);
    clearRegistration();
    setDemo(null);
    setError('');
    setMaximized(null);
    setCtTriangles(0);
    // 作废还在计算的等值面，免得它算完又把旧 CBCT 表面加回来。
    surfaceToken.current++;
    ctView.current?.setMesh('ct', null);
  };

  // ---- CBCT 等值面：阈值变化后稍作防抖再重算 ----
  useEffect(() => {
    if (!ct) return;
    const token = ++surfaceToken.current;
    const timer = setTimeout(async () => {
      try {
        const mesh = await worker.current!.run({ type: 'displaySurface', iso: threshold, minComponent: 120 });
        if (token !== surfaceToken.current || !ctView.current) return;
        ctView.current.setMesh('ct', mesh, { color: CT_COLOR, roughness: 0.62 });
        ctView.current.setMeshDisplay('ct', true, displayRef.current.ctOpacity);
        setCtTriangles(mesh.indices.length / 3);
        if (pendingCtFit.current) {
          pendingCtFit.current = false;
          ctView.current.fit(['ct'], 'front');
        }
      } catch (reason) {
        if (token === surfaceToken.current) setError(reason instanceof Error ? reason.message : String(reason));
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [ct, threshold]);

  // ---- 口扫网格同步到两个视口 ----
  useEffect(() => {
    const left = iosView.current, right = ctView.current;
    if (!left || !right) return;
    left.setMesh('ios', ios?.mesh || null, { color: IOS_STONE_COLOR, roughness: 0.42, accelerate: true });
    right.setMesh('ios', ios?.mesh || null, { color: IOS_COLOR, roughness: 0.4 });
    if (ios) left.fit(['ios'], 'top');
  }, [ios]);

  const matrix = registration?.matrix || null;
  useEffect(() => {
    const left = iosView.current, right = ctView.current;
    if (!left || !right) return;
    // 配准后把口扫也摆到患者坐标系里，左右两个视口的方位就一致了。
    left.setMeshMatrix('ios', matrix);
    right.setMeshMatrix('ios', matrix);
    if (ios) left.fit(['ios'], 'top');
  }, [ios, matrix]);

  useEffect(() => {
    ctView.current?.setMeshDisplay('ios', !!matrix && display.overlay);
    ctView.current?.setMeshDisplay('ct', true, display.ctOpacity);
  }, [ios, matrix, display.overlay, display.ctOpacity]);

  useEffect(() => {
    if (!ios) return;
    const colors = deviation && display.heatmap ? deviationToColors(deviation) : ios.mesh.colors || null;
    iosView.current?.setMeshColors('ios', colors, IOS_STONE_COLOR);
  }, [ios, deviation, display.heatmap]);

  // ---- 标记点 ----
  useEffect(() => {
    iosView.current?.setMarkers(iosPoints.map((p, i) => ({
      position: matrix ? transformPoint(matrix, p[0], p[1], p[2]) : p,
      label: String(i + 1),
      color: LANDMARK_COLORS[i]
    })));
  }, [iosPoints, matrix, ios]);

  useEffect(() => {
    ctView.current?.setMarkers(ctPoints.map((p, i) => ({ position: p, label: String(i + 1), color: LANDMARK_COLORS[i] })));
  }, [ctPoints, ct]);

  useEffect(() => { ctView.current?.setCursor(ct ? cursor : null); }, [ct, cursor]);

  useEffect(() => {
    const left = iosView.current, right = ctView.current;
    if (!left || !right) return;
    left.onPick = event => {
      if (!pickMode || taskRunning.current) return;
      setIosPoints(points => (points.length >= MAX_LANDMARKS ? points : [...points, event.local]));
      clearRegistration();
    };
    right.onPick = event => {
      setCursor(event.world);
      if (!pickMode || taskRunning.current) return;
      setCtPoints(points => (points.length >= MAX_LANDMARKS ? points : [...points, event.world]));
      clearRegistration();
    };
  }, [pickMode, clearRegistration]);

  const removePair = (index: number) => {
    setIosPoints(points => points.filter((_, i) => i !== index));
    setCtPoints(points => points.filter((_, i) => i !== index));
    clearRegistration();
  };

  const undoLastPoint = () => {
    // 撤销较长的一侧；两侧等长时先撤 CBCT 上的点。
    if (iosPoints.length > ctPoints.length) setIosPoints(points => points.slice(0, -1));
    else setCtPoints(points => points.slice(0, -1));
    clearRegistration();
  };

  const fillDemoLandmarks = () => {
    if (!demo) return;
    // 模拟人工点选：两侧各带约 ±0.5 mm 的随机偏差，交给 ICP 去修正。
    const jitter = () => (Math.random() - 0.5) * 1.0;
    setIosPoints(demo.hints.map(hint => [hint.ios[0] + jitter(), hint.ios[1] + jitter(), hint.ios[2] + jitter()]));
    setCtPoints(demo.hints.map(hint => [hint.ct[0] + jitter(), hint.ct[1] + jitter(), hint.ct[2] + jitter()]));
    clearRegistration();
  };

  // ---- 配准 ----
  const runLandmarkRegistration = () => {
    if (pairCount < 3) return;
    setError('');
    const src = flatten(iosPoints, pairCount), dst = flatten(ctPoints, pairCount);
    const fitted = fitRigid(src, dst, pairCount);
    const residuals = pairResiduals(fitted, src, dst, pairCount);
    setRegistration({ matrix: fitted, stage: 'landmark', residuals, landmarkRms: rootMeanSquare(residuals) });
    setDeviation(null);
    setPickMode(false);
    setCursor(ctPoints[0]);
  };

  const runIcpRegistration = () => guarded('正在提取口扫附近的 CBCT 牙面', async () => {
    if (!ct || !ios || !registration) return;
    const epoch = registrationEpoch.current;
    const client = worker.current!;
    const { mesh, normals } = ios;
    const vertexCount = mesh.positions.length / 3;

    // 只在粗配准后口扫所在的范围内、以全分辨率重新提取牙面作为 ICP 目标。
    const coarse = transformPositions(mesh.positions, registration.matrix);
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < coarse.length; i++) {
      if (coarse[i] < min[i % 3]) min[i % 3] = coarse[i];
      if (coarse[i] > max[i % 3]) max[i % 3] = coarse[i];
    }
    const box = mmBoxToVoxelBox(ct.volume, min, max, 4);
    const voxels = (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1);
    const step = voxels > 60_000_000 ? 2 : 1;
    const sub = extractSubVolume(ct.volume, box, step);

    const stride = Math.max(1, Math.floor(vertexCount / 15000));
    const count = Math.ceil(vertexCount / stride);
    const points = new Float32Array(count * 3), sampleNormals = new Float32Array(count * 3);
    for (let i = 0, v = 0; i < count; i++, v += stride) {
      points.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3);
      sampleNormals.set(normals.subarray(v * 3, v * 3 + 3), i * 3);
    }
    const startDistance = Math.min(6, Math.max(2, registration.landmarkRms * 3));
    const result = await client.run(
      { type: 'register', sub, iso: threshold, points, normals: sampleNormals, initial: registration.matrix, startDistance },
      [sub.data.buffer],
      (stage, iteration, rms, inliers) => setBusy({ label: `${stage}：第 ${iteration} 轮 · 表面 RMS ${rms.toFixed(3)} mm · ${inliers} 个对应点` })
    );
    if (result.summary.matched < 50) throw new Error('ICP 没有找到足够的对应牙面。请检查标记点顺序，或调整牙面阈值后重试。');

    setBusy({ label: '正在计算表面偏差' });
    const { distances } = await client.run({ type: 'distances', positions: mesh.positions, matrix: result.matrix, maxDistance: DEVIATION_MAX_MM });
    // 计算期间模型或标记点被改过，这份结果对不上当前数据，丢弃。
    if (epoch !== registrationEpoch.current) return;
    const src = flatten(iosPoints, pairCount), dst = flatten(ctPoints, pairCount);
    setRegistration({
      matrix: result.matrix,
      stage: 'icp',
      residuals: pairResiduals(result.matrix, src, dst, pairCount),
      landmarkRms: registration.landmarkRms,
      icp: result.summary,
      icpThreshold: result.calibratedIso ?? threshold,
      calibrated: result.calibratedIso !== null
    });
    setDeviation(distances);
  });

  const truthError = useMemo(() => {
    if (!demo || !ios || !matrix) return null;
    const p = ios.mesh.positions;
    let sum = 0, n = 0;
    for (let v = 0; v < p.length; v += 3 * 11, n++) {
      const a = transformPoint(matrix, p[v], p[v + 1], p[v + 2]);
      const b = transformPoint(demo.truth, p[v], p[v + 1], p[v + 2]);
      sum += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    }
    return Math.sqrt(sum / n);
  }, [demo, ios, matrix]);

  // ---- 切面 ----
  const lut = useMemo(() => {
    const table = new Uint8Array(65536);
    const lo = windowLevel.center - windowLevel.width / 2;
    for (let i = 0; i < 65536; i++) table[i] = Math.max(0, Math.min(255, Math.round(((i - 32768 - lo) / windowLevel.width) * 255)));
    return table;
  }, [windowLevel]);

  const iosInCt = useMemo(() => (ios && matrix ? transformPositions(ios.mesh.positions, matrix) : null), [ios, matrix]);
  const contourX = useMemo(() => (iosInCt && ios && display.overlay ? sliceContour(iosInCt, ios.mesh.indices, 0, cursor[0]) : null), [iosInCt, ios, display.overlay, cursor[0]]);
  const contourY = useMemo(() => (iosInCt && ios && display.overlay ? sliceContour(iosInCt, ios.mesh.indices, 1, cursor[1]) : null), [iosInCt, ios, display.overlay, cursor[1]]);
  const contourZ = useMemo(() => (iosInCt && ios && display.overlay ? sliceContour(iosInCt, ios.mesh.indices, 2, cursor[2]) : null), [iosInCt, ios, display.overlay, cursor[2]]);
  const contours = [contourX, contourY, contourZ];
  const sliceMarkers = useMemo(() => ctPoints.map((p, i) => ({ position: p, label: String(i + 1), color: LANDMARK_COLORS[i] })), [ctPoints]);

  // ---- 导出 ----
  const exportMatrix = () => {
    if (!ct || !ios || !registration) return;
    const toPatient = multiply(ct.volume.toPatient, registration.matrix);
    const payload = {
      app: 'DentalSystem',
      type: 'ios-cbct-rigid-registration',
      version: 1,
      createdAt: new Date().toISOString(),
      convention: '4x4 刚体矩阵按行排列，单位毫米；p_目标 = M · p_口扫',
      cbct: { name: ct.name, description: ct.volume.meta.description, dims: ct.volume.dims, spacing: ct.volume.spacing, warnings: ct.volume.meta.warnings },
      ios: { name: ios.name, triangles: ios.mesh.indices.length / 3 },
      iosToCbctVoxelMm: toRows(registration.matrix),
      iosToPatientLps: toRows(toPatient),
      stage: registration.stage,
      landmarks: { ios: iosPoints.slice(0, pairCount), cbct: ctPoints.slice(0, pairCount), rmsMm: registration.landmarkRms },
      surfaceFit: registration.icp ? { ...registration.icp, threshold: registration.icpThreshold } : null
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'ios-cbct-registration.json');
  };

  const exportMesh = () => {
    if (!ct || !ios || !registration) return;
    const toPatient = multiply(ct.volume.toPatient, registration.matrix);
    const base = ios.name.replace(/\.[^.]+$/, '') || 'ios';
    downloadBlob(new Blob([writeBinaryStl(ios.mesh, toPatient)], { type: 'model/stl' }), `${base}-registered.stl`);
  };

  const quality = registration?.icp ? fitQuality(registration.icp) : null;
  const steps = [
    { label: '载入数据', done: ready },
    { label: '标记对应点', done: pairCount >= 3 },
    { label: '配准', done: registration?.stage === 'icp' },
    { label: '核验与导出', done: false }
  ];
  const activeStep = steps.findIndex(step => !step.done);

  const paneClass = (key: PaneKey, span: string) => {
    if (maximized) return maximized === key ? 'col-span-6 row-span-2' : 'hidden';
    return span;
  };

  const paneToolbar = (key: PaneKey, view?: React.MutableRefObject<Viewport3D | null>, presets = false) => (
    <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
      {view && presets && VIEW_PRESETS.map(preset => (
        <button key={preset.key} type="button" title={`${preset.label}视图`} onClick={() => view.current?.fit(undefined, preset.key)}
          className="h-6 w-6 rounded bg-slate-800/80 text-xs text-slate-300 transition-colors hover:bg-teal-600 hover:text-white">
          {preset.label}
        </button>
      ))}
      {view && (
        <button type="button" title="适应窗口" onClick={() => view.current?.fit()}
          className="flex h-6 w-6 items-center justify-center rounded bg-slate-800/80 text-slate-300 transition-colors hover:bg-teal-600 hover:text-white">
          <Scan size={13} />
        </button>
      )}
      <button type="button" title={maximized === key ? '还原' : '最大化'} onClick={() => setMaximized(maximized === key ? null : key)}
        className="flex h-6 w-6 items-center justify-center rounded bg-slate-800/80 text-slate-300 transition-colors hover:bg-teal-600 hover:text-white">
        {maximized === key ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
    </div>
  );

  return (
    <div
      className="tone-flip relative flex min-h-0 flex-1 flex-col bg-slate-950 text-slate-200"
      onDragEnter={() => { dragDepth.current++; setDragging(true); }}
      onDragOver={event => event.preventDefault()}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={event => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (taskRunning.current) return;
        void collectDroppedFiles(event.dataTransfer.items).then(handleFiles);
      }}
    >
      <input ref={folderInput} type="file" multiple className="hidden" onChange={event => { handleFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <input ref={ctFileInput} type="file" multiple className="hidden" onChange={event => { handleFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <input ref={iosFileInput} type="file" accept=".stl,.ply,.obj" className="hidden" onChange={event => { handleFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />

      <header className="app-drag flex flex-shrink-0 items-center gap-6 border-b border-slate-800 bg-slate-900 px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold leading-tight text-white">影像融合</h1>
          <p className="text-xs text-slate-400">口扫三维模型 × CBCT 刚性配准</p>
        </div>
        <ol className="hidden flex-1 items-center gap-2 lg:flex">
          {steps.map((step, index) => (
            <li key={step.label} className="flex items-center gap-2">
              {index > 0 && <span className={`h-px w-6 ${steps[index - 1].done ? 'bg-teal-500' : 'bg-slate-700'}`} />}
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${step.done ? 'bg-primary text-on-primary' : index === activeStep ? 'bg-slate-100 text-slate-900' : 'bg-slate-800 text-slate-400'}`}>
                {step.done ? <Check size={13} strokeWidth={3} /> : index + 1}
              </span>
              <span className={`text-sm ${step.done || index === activeStep ? 'font-medium text-slate-100' : 'text-slate-400'}`}>{step.label}</span>
            </li>
          ))}
        </ol>
        <div className="app-no-drag ml-auto flex items-center gap-2">
          <button type="button" onClick={loadDemo} disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 transition-colors hover:border-teal-500 hover:text-white disabled:opacity-50">
            <Sparkles size={15} /> 演示病例
          </button>
          {(ct || ios) && (
            <button type="button" onClick={resetAll} disabled={!!busy} title="清空当前数据"
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50">
              <RotateCcw size={15} /> 重置
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] flex-shrink-0 flex-col overflow-y-auto border-r border-slate-800 bg-slate-900">
          <PanelSection index={1} title="数据">
            <DataCard
              icon={<Layers size={16} />}
              title="CBCT"
              empty="DICOM 序列或 NIfTI"
              loaded={ct ? ct.name : null}
              details={ct ? [
                `${ct.volume.dims.join(' × ')} 体素`,
                `体素 ${ct.volume.spacing.map(v => v.toFixed(2)).join(' × ')} mm`
              ] : []}
              warnings={ct?.volume.meta.warnings || []}
              actions={<>
                <SmallButton onClick={() => folderInput.current?.click()} disabled={!!busy}><FolderOpen size={14} /> DICOM 文件夹</SmallButton>
                <SmallButton onClick={() => ctFileInput.current?.click()} disabled={!!busy}><FileUp size={14} /> 文件</SmallButton>
              </>}
            />
            <DataCard
              icon={<Box size={16} />}
              title="口扫模型"
              empty="STL / PLY / OBJ，单位毫米"
              loaded={ios ? ios.name : null}
              details={ios ? [
                `${(ios.mesh.indices.length / 3).toLocaleString()} 个三角面`,
                `范围 ${ios.size.map(v => v.toFixed(0)).join(' × ')} mm`
              ] : []}
              warnings={ios && Math.max(...ios.size) < 5 ? ['模型尺寸异常偏小，可能不是以毫米为单位导出的。'] : []}
              actions={<SmallButton onClick={() => iosFileInput.current?.click()} disabled={!!busy}><FileUp size={14} /> 选择模型</SmallButton>}
            />
            {demo && <p className="text-xs leading-5 text-slate-400">当前为程序合成的演示数据，不含任何真实患者信息。</p>}
          </PanelSection>

          {ct && (
            <PanelSection index={2} title="CBCT 牙面">
              <div className="flex items-baseline justify-between">
                <label htmlFor="iso" className="text-sm text-slate-300">等值面阈值</label>
                <span className="font-mono text-sm text-white">{threshold}</span>
              </div>
              <input id="iso" type="range" min={Math.max(-200, Math.round(ct.volume.range[0]))} max={Math.round(Math.min(ct.volume.range[1], ct.thresholds.teeth * 2.2))} step={10}
                value={threshold} onChange={event => setThreshold(Number(event.target.value))}
                className="w-full accent-primary" />
              <div className="flex items-center gap-2">
                <SmallButton onClick={() => setThreshold(ct.thresholds.bone)} active={threshold === ct.thresholds.bone}>骨 {ct.thresholds.bone}</SmallButton>
                <SmallButton onClick={() => setThreshold(ct.thresholds.teeth)} active={threshold === ct.thresholds.teeth}>牙 {ct.thresholds.teeth}</SmallButton>
                <span className="ml-auto text-xs text-slate-400">{ctTriangles ? `${(ctTriangles / 1000).toFixed(0)}k 面` : '计算中…'}</span>
              </div>
              <p className="text-xs leading-5 text-slate-400">
                调到牙冠轮廓清晰、相邻牙不粘连为宜。ICP 先以这个阈值下的牙面为目标，再自动校准到牙冠边缘的实际灰度；配准完成后可以调低阈值查看颌骨。CBCT 灰度未严格标定，预设值由直方图估计。
              </p>
            </PanelSection>
          )}

          {ready && (
            <PanelSection index={3} title="标记对应点" aside={`${pairCount} 对`}>
              <button type="button" onClick={() => setPickMode(mode => !mode)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${pickMode ? 'border-teal-500 bg-teal-500/10 text-teal-200' : 'border-slate-700 text-slate-300 hover:border-slate-500'}`}>
                <MousePointerClick size={16} />
                <span className="flex-1 text-left">{pickMode ? '点选模式已开启' : '点选模式已关闭'}</span>
                <span className={`h-4 w-8 rounded-full p-0.5 transition-colors ${pickMode ? 'bg-teal-500' : 'bg-slate-600'}`}>
                  <span className={`block h-3 w-3 rounded-full bg-white transition-transform ${pickMode ? 'translate-x-4' : ''}`} />
                </span>
              </button>
              <p className="text-xs leading-5 text-slate-400">
                在口扫和 CBCT 上按相同顺序各点至少 3 个对应位置。优先选牙尖、切缘这类清晰的解剖点，并让它们分布在牙弓两侧和前牙区。
              </p>
              {(iosPoints.length > 0 || ctPoints.length > 0) && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-400">
                      <th className="pb-1 font-normal">#</th>
                      <th className="pb-1 font-normal">口扫</th>
                      <th className="pb-1 font-normal">CBCT</th>
                      <th className="pb-1 text-right font-normal">残差</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: Math.max(iosPoints.length, ctPoints.length) }, (_, i) => (
                      <tr key={i} className="border-t border-slate-800">
                        <td className="py-1.5">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold text-white" style={{ background: LANDMARK_COLORS[i] }}>{i + 1}</span>
                        </td>
                        <td className={iosPoints[i] ? 'text-slate-200' : 'text-slate-600'}>{iosPoints[i] ? '已标记' : '待点选'}</td>
                        <td className={ctPoints[i] ? 'text-slate-200' : 'text-slate-600'}>
                          {ctPoints[i]
                            ? <button type="button" className="hover:text-teal-300" title="把切面十字线移到这个点" onClick={() => setCursor(ctPoints[i])}>已标记</button>
                            : '待点选'}
                        </td>
                        <td className="text-right font-mono text-xs text-slate-300">{registration?.residuals[i] !== undefined ? registration.residuals[i].toFixed(2) : '—'}</td>
                        <td className="w-6 text-right">
                          <button type="button" title="删除这一对" onClick={() => removePair(i)} className="text-slate-400 hover:text-red-400"><Trash2 size={14} /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="flex flex-wrap gap-2">
                <SmallButton onClick={undoLastPoint} disabled={!iosPoints.length && !ctPoints.length}><Undo2 size={14} /> 撤销</SmallButton>
                <SmallButton onClick={() => { setIosPoints([]); setCtPoints([]); clearRegistration(); }} disabled={!iosPoints.length && !ctPoints.length}><Trash2 size={14} /> 清空</SmallButton>
                {demo && <SmallButton onClick={fillDemoLandmarks}><Wand2 size={14} /> 填入示例点</SmallButton>}
              </div>
              {iosPoints.length !== ctPoints.length && (
                <p className="text-xs text-amber-300">两侧点数不一致，多出的点不会参与配准。</p>
              )}
            </PanelSection>
          )}

          {ready && (
            <PanelSection index={4} title="配准">
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={runLandmarkRegistration} disabled={pairCount < 3 || !!busy}
                  className="rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-100 transition-colors hover:border-teal-500 disabled:cursor-not-allowed disabled:opacity-40">
                  ① 标记点粗配准
                </button>
                <button type="button" onClick={runIcpRegistration} disabled={!registration || !!busy}
                  className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
                  ② ICP 精配准
                </button>
              </div>
              {ct?.volume.meta.orientationUncertain && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  <span>这套 CBCT 缺少切片位置信息，左右方向无法确认。表面偏差再小也不能排除左右互换，请先在切面上核对左右。</span>
                </div>
              )}
              {!registration && <p className="text-xs leading-5 text-slate-400">先用标记点把口扫大致摆到位，再由 ICP 让口扫牙冠表面贴合 CBCT 牙面。</p>}
              {registration && (
                <dl className="space-y-1.5 text-sm">
                  <StatRow label="标记点残差 (RMS)" value={formatMm(registration.landmarkRms)} warn={registration.landmarkRms > 2} />
                  {registration.landmarkRms > 2 && <p className="text-xs text-amber-300">残差偏大，通常是两侧点选顺序不一致或点错了牙位。</p>}
                  {registration.icp && <>
                    <StatRow label="表面偏差中位数" value={formatMm(registration.icp.median)} />
                    <StatRow label="表面偏差 RMS" value={formatMm(registration.icp.rms)} />
                    <StatRow label="95% 分位" value={formatMm(registration.icp.p95)} />
                    <StatRow label="偏差 ≤ 0.2 mm" value={`${(registration.icp.within02 * 100).toFixed(0)}%`} />
                    <StatRow label="参与统计的采样点" value={`${registration.icp.matched.toLocaleString()} / ${registration.icp.total.toLocaleString()}`} />
                    <StatRow label={registration.calibrated ? '牙面等值（自动校准）' : '牙面等值（人工阈值）'} value={String(Math.round(registration.icpThreshold ?? threshold))} warn={!registration.calibrated} />
                    <StatRow label="迭代" value={`${registration.icp.iterations} 轮${registration.icp.converged ? '，已收敛' : '，未收敛'}`} warn={!registration.icp.converged} />
                  </>}
                  {truthError !== null && <StatRow label="与真值的偏差（仅演示）" value={formatMm(truthError)} />}
                </dl>
              )}
              {quality && (
                <div className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${quality.tone === 'good' ? 'border-teal-500/40 bg-teal-500/10 text-teal-200' : quality.tone === 'ok' ? 'border-sky-500/40 bg-sky-500/10 text-sky-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
                  {quality.tone === 'warn' ? <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" /> : <Check size={16} className="mt-0.5 flex-shrink-0" />}
                  <span>{quality.label}</span>
                </div>
              )}
              {registration?.icp && (
                <p className="text-xs leading-5 text-slate-400">
                  表面偏差只统计找到对应牙面的采样点，牙龈等 CBCT 上没有对应面的区域已被剔除。数值小不等于配准一定正确，请在切面上逐牙确认轮廓贴合。
                </p>
              )}
            </PanelSection>
          )}

          {registration && (
            <PanelSection index={5} title="核验与导出">
              <ToggleRow label="在 CBCT 视图和切面上叠加口扫" checked={display.overlay} onChange={overlay => setDisplay(state => ({ ...state, overlay }))} />
              {deviation && <ToggleRow label="口扫上显示表面偏差" checked={display.heatmap} onChange={heatmap => setDisplay(state => ({ ...state, heatmap }))} />}
              <div>
                <div className="flex items-baseline justify-between text-sm text-slate-300">
                  <label htmlFor="ct-opacity">CBCT 表面不透明度</label>
                  <span className="font-mono text-xs">{Math.round(display.ctOpacity * 100)}%</span>
                </div>
                <input id="ct-opacity" type="range" min={0.15} max={1} step={0.05} value={display.ctOpacity}
                  onChange={event => setDisplay(state => ({ ...state, ctOpacity: Number(event.target.value) }))} className="w-full accent-primary" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <SmallButton onClick={exportMatrix}><Download size={14} /> 配准矩阵 JSON</SmallButton>
                <SmallButton onClick={exportMesh}><Download size={14} /> 配准后 STL</SmallButton>
              </div>
              <p className="text-xs leading-5 text-slate-400">导出的 STL 已变换到 CBCT 的 DICOM 患者坐标系 (LPS)，可直接与同一套 CBCT 在种植规划等软件中叠加。</p>
            </PanelSection>
          )}

          {ct && (
            <PanelSection title="切面显示">
              <RangeRow label="窗位" value={windowLevel.center} min={-500} max={3000} step={10} onChange={center => setWindowLevel(state => ({ ...state, center }))} />
              <RangeRow label="窗宽" value={windowLevel.width} min={200} max={6000} step={20} onChange={width => setWindowLevel(state => ({ ...state, width }))} />
            </PanelSection>
          )}

          <div className="mt-auto border-t border-slate-800 px-4 py-3 text-xs leading-5 text-slate-400">
            影像只在本机内存中处理，不写入诊所数据库，也不会随云端备份上传。配准结果用于辅助阅片，不能替代医生判断。
          </div>
        </aside>

        <section className="relative min-w-0 flex-1">
          <div className="tone-dark grid h-full grid-cols-6 grid-rows-[3fr_2fr] gap-px bg-slate-800">
            <div className={`relative min-h-0 bg-gradient-to-b from-slate-900 to-slate-950 ${paneClass('ios', 'col-span-3')}`}>
              <div ref={iosContainer} className="absolute inset-0" />
              <PaneTitle color={IOS_COLOR} title="口扫模型" hint={!ios ? '' : pickMode ? '单击模型表面添加标记点' : matrix ? '已对齐到患者坐标系' : ''} />
              {paneToolbar('ios', iosView, !!matrix)}
              {deviation && display.heatmap && (
                <div className="absolute bottom-3 left-3 rounded-lg bg-slate-950/80 px-3 py-2 text-xs text-slate-300 backdrop-blur">
                  <div className="mb-1 text-slate-400">到 CBCT 牙面的距离</div>
                  <div className="h-2 w-44 rounded-full" style={{ background: `linear-gradient(to right, ${DEVIATION_RAMP.join(', ')})` }} />
                  <div className="mt-1 flex w-44 justify-between font-mono text-[11px]">
                    <span>0</span><span>{(DEVIATION_MAX_MM / 2).toFixed(1)}</span><span>{DEVIATION_MAX_MM.toFixed(1)} mm</span>
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: DEVIATION_NONE }} /> 超过 {DEVIATION_MAX_MM.toFixed(0)} mm 或无对应面（牙龈等）
                  </div>
                </div>
              )}
            </div>
            <div className={`relative min-h-0 bg-gradient-to-b from-slate-900 to-slate-950 ${paneClass('ct', 'col-span-3')}`}>
              <div ref={ctContainer} className="absolute inset-0" />
              <PaneTitle color={CT_COLOR} title={matrix ? 'CBCT + 口扫融合' : 'CBCT 三维'} hint={!ct ? '' : pickMode && ios ? '单击牙面添加标记点' : '单击表面定位切面'} />
              {paneToolbar('ct', ctView, true)}
              {matrix && display.overlay && (
                <div className="absolute bottom-3 left-3 flex items-center gap-3 rounded-lg bg-slate-950/80 px-3 py-1.5 text-xs text-slate-300 backdrop-blur">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: CT_COLOR }} /> CBCT</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: IOS_COLOR }} /> 口扫</span>
                </div>
              )}
            </div>
            {SLICE_PANES.map(pane => (
              <div key={pane.key} className={`relative min-h-0 bg-black ${paneClass(pane.key, 'col-span-2')}`}>
                {ct && (
                  <SliceView
                    volume={ct.volume}
                    axis={pane.axis}
                    title={pane.title}
                    cursor={cursor}
                    lut={lut}
                    contour={contours[pane.axis]}
                    contourColor={IOS_COLOR}
                    markers={sliceMarkers}
                    onCursorChange={setCursor}
                  />
                )}
                {paneToolbar(pane.key)}
              </div>
            ))}
          </div>

          {!ct && !ios && !busy && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950">
              <div className="max-w-xl px-8 text-center">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-300"><Crosshair size={28} /></div>
                <h2 className="text-2xl font-bold text-white">把口扫模型对到 CBCT 上</h2>
                <p className="mt-3 text-sm leading-6 text-slate-400">
                  口扫给出高精度的牙冠和牙龈表面，CBCT 给出牙根、颌骨和神经管。载入两份数据，点 3 对以上对应点完成粗配准，再用 ICP 让牙冠表面精确贴合，最后在三个切面上核验并导出。
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                  <button type="button" onClick={loadDemo} className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary transition-opacity hover:opacity-90">
                    <Sparkles size={16} /> 载入演示病例
                  </button>
                  <button type="button" onClick={() => folderInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 transition-colors hover:border-slate-500">
                    <FolderOpen size={16} /> 选择 CBCT 文件夹
                  </button>
                  <button type="button" onClick={() => iosFileInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-200 transition-colors hover:border-slate-500">
                    <FileUp size={16} /> 选择口扫模型
                  </button>
                </div>
                <p className="mt-5 text-xs text-slate-400">也可以把 DICOM 文件夹、NIfTI 或 STL / PLY / OBJ 文件直接拖进来。</p>
              </div>
            </div>
          )}

          {(busy || error) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center px-4">
              {busy ? (
                <div className="flex items-center gap-3 rounded-full border border-slate-700 bg-slate-900/95 px-4 py-2 text-sm text-slate-100 shadow-xl">
                  <Loader2 size={16} className="animate-spin text-teal-400" />
                  <span>{busy.label}</span>
                  {busy.progress !== undefined && (
                    <span className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-700">
                      <span className="block h-full bg-teal-500" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
                    </span>
                  )}
                </div>
              ) : (
                <div className="pointer-events-auto flex max-w-2xl items-start gap-3 rounded-xl border border-red-500/40 bg-red-950/90 px-4 py-3 text-sm text-red-100 shadow-xl">
                  <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                  <span className="flex-1">{error}</span>
                  <button type="button" onClick={() => setError('')} className="text-red-300 hover:text-white">知道了</button>
                </div>
              )}
            </div>
          )}

          {dragging && !busy && (
            <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-2xl border-2 border-dashed border-teal-400 bg-teal-500/10 text-lg font-medium text-teal-100">
              松开以载入 CBCT 或口扫模型
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const PanelSection = ({ index, title, aside, children }: { index?: number; title: string; aside?: string; children: React.ReactNode }) => (
  <section className="space-y-3 border-b border-slate-800 px-4 py-4">
    <div className="flex items-center gap-2">
      {index !== undefined && <span className="flex h-5 w-5 items-center justify-center rounded bg-slate-800 text-[11px] font-bold text-slate-400">{index}</span>}
      <h2 className="text-sm font-bold text-slate-100">{title}</h2>
      {aside && <span className="ml-auto text-xs text-slate-400">{aside}</span>}
    </div>
    {children}
  </section>
);

const DataCard = ({ icon, title, empty, loaded, details, warnings, actions }: {
  icon: React.ReactNode; title: string; empty: string; loaded: string | null; details: string[]; warnings: string[]; actions: React.ReactNode;
}) => (
  <div className={`rounded-lg border px-3 py-2.5 ${loaded ? 'border-slate-700 bg-slate-800/50' : 'border-dashed border-slate-700'}`}>
    <div className="flex items-center gap-2">
      <span className={loaded ? 'text-teal-400' : 'text-slate-400'}>{icon}</span>
      <span className="text-sm font-medium text-slate-100">{title}</span>
      {loaded && <Check size={14} className="text-teal-400" />}
    </div>
    <div className={`mt-1 truncate text-xs ${loaded ? 'text-slate-300' : 'text-slate-400'}`} title={loaded || undefined}>{loaded || empty}</div>
    {details.map(line => <div key={line} className="font-mono text-[11px] text-slate-400">{line}</div>)}
    {warnings.map(line => (
      <div key={line} className="mt-1 flex items-start gap-1.5 text-xs text-amber-300"><AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {line}</div>
    ))}
    <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
  </div>
);

const SmallButton = ({ children, onClick, disabled, active }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; active?: boolean }) => (
  <button type="button" onClick={onClick} disabled={disabled}
    className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${active ? 'border-teal-500 text-teal-200' : 'border-slate-700 text-slate-300 hover:border-slate-500 hover:text-white'}`}>
    {children}
  </button>
);

const StatRow = ({ label, value, warn }: { label: string; value: string; warn?: boolean }) => (
  <div className="flex items-baseline justify-between gap-3">
    <dt className="text-slate-400">{label}</dt>
    <dd className={`font-mono ${warn ? 'text-amber-300' : 'text-slate-100'}`}>{value}</dd>
  </div>
);

const ToggleRow = ({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) => (
  <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center gap-2 text-left text-sm text-slate-300 hover:text-white">
    {checked ? <Eye size={15} className="text-teal-400" /> : <EyeOff size={15} className="text-slate-400" />}
    <span>{label}</span>
  </button>
);

const RangeRow = ({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) => (
  <label className="flex items-center gap-3 text-sm text-slate-300">
    <span className="w-9 flex-shrink-0">{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="min-w-0 flex-1 accent-primary" />
    <span className="w-12 text-right font-mono text-xs">{value}</span>
  </label>
);

const PaneTitle = ({ color, title, hint }: { color: string; title: string; hint: string }) => (
  <>
    <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2">
      <span className="h-3.5 w-[3px]" style={{ background: color }} />
      <span className="text-xs font-semibold text-slate-100">{title}</span>
    </div>
    {hint && <div className="pointer-events-none absolute bottom-3 right-3 z-10 text-xs text-slate-400">{hint}</div>}
  </>
);
