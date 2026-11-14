import React, { useEffect, useRef } from 'react';
import type { Vec3, VolumeData } from '../types';
import { voxelAt } from '../math/volume';
import { sliceAxes, SliceAxis } from './contours';

export interface SliceMarker {
  position: Vec3;
  label: string;
  color: string;
}

interface SliceViewProps {
  volume: VolumeData;
  axis: SliceAxis;
  title: string;
  cursor: Vec3;
  lut: Uint8Array;
  contour: Float32Array | null;
  contourColor: string;
  markers: SliceMarker[];
  onCursorChange: (cursor: Vec3) => void;
}

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));

// 根据体数据方向矩阵，给出体素轴正/负方向对应的患者方位。
const patientSide = (volume: VolumeData, axis: SliceAxis, positive: boolean) => {
  const m = volume.toPatient;
  const sign = positive ? 1 : -1;
  const d = [m[axis * 4] * sign, m[axis * 4 + 1] * sign, m[axis * 4 + 2] * sign];
  const abs = d.map(Math.abs);
  if (abs[0] >= abs[1] && abs[0] >= abs[2]) return d[0] > 0 ? '左' : '右';
  if (abs[1] >= abs[2]) return d[1] > 0 ? '后' : '前';
  return d[2] > 0 ? '上' : '下';
};

export const SliceView = (props: SliceViewProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const view = useRef({ zoom: 1, panX: 0, panY: 0 });
  const cache = useRef<{ canvas: HTMLCanvasElement; key: unknown[] } | null>(null);
  const drawRef = useRef<() => void>(() => undefined);
  const layout = useRef({ ox: 0, oy: 0, scale: 1 });

  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { volume, axis, cursor, lut, contour, contourColor, markers, title } = latest.current;
    const { h, v, flipV } = sliceAxes(axis);
    const { dims, spacing, data } = volume;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    const index = clamp(Math.round(cursor[axis] / spacing[axis]), 0, dims[axis] - 1);
    const W = dims[h], H = dims[v];
    const key = [volume, axis, index, lut];
    if (!cache.current || cache.current.key.some((item, i) => item !== key[i])) {
      const off = cache.current?.canvas || document.createElement('canvas');
      off.width = W;
      off.height = H;
      const offCtx = off.getContext('2d')!;
      const image = offCtx.createImageData(W, H);
      const pixels = new Uint32Array(image.data.buffer);
      const strides = [1, dims[0], dims[0] * dims[1]];
      const base = index * strides[axis];
      for (let r = 0; r < H; r++) {
        const row = base + (flipV ? H - 1 - r : r) * strides[v];
        for (let c = 0; c < W; c++) {
          const g = lut[data[row + c * strides[h]] + 32768];
          pixels[r * W + c] = 0xff000000 | (g << 16) | (g << 8) | g;
        }
      }
      offCtx.putImageData(image, 0, 0);
      cache.current = { canvas: off, key };
    }

    const widthMm = W * spacing[h], heightMm = H * spacing[v];
    const scale = Math.min(width / widthMm, height / heightMm) * 0.94 * view.current.zoom;
    const ox = width / 2 + view.current.panX - (widthMm * scale) / 2;
    const oy = height / 2 + view.current.panY - (heightMm * scale) / 2;
    layout.current = { ox, oy, scale };
    const sx = (mm: number) => ox + (mm + spacing[h] / 2) * scale;
    const sy = (mm: number) => oy + ((flipV ? (H - 1) * spacing[v] - mm : mm) + spacing[v] / 2) * scale;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cache.current.canvas, ox, oy, widthMm * scale, heightMm * scale);

    if (contour && contour.length) {
      ctx.beginPath();
      for (let i = 0; i < contour.length; i += 4) {
        ctx.moveTo(sx(contour[i]), sy(contour[i + 1]));
        ctx.lineTo(sx(contour[i + 2]), sy(contour[i + 3]));
      }
      ctx.lineCap = 'round';
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(2, 6, 23, 0.7)';
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = contourColor;
      ctx.stroke();
    }

    // 十字线：中心留空，避免挡住正在观察的位置。
    const cx = sx(cursor[h]), cy = sy(cursor[v]);
    const gap = 9;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.75)';
    ctx.beginPath();
    ctx.moveTo(cx + 0.5, 0); ctx.lineTo(cx + 0.5, cy - gap);
    ctx.moveTo(cx + 0.5, cy + gap); ctx.lineTo(cx + 0.5, height);
    ctx.moveTo(0, cy + 0.5); ctx.lineTo(cx - gap, cy + 0.5);
    ctx.moveTo(cx + gap, cy + 0.5); ctx.lineTo(width, cy + 0.5);
    ctx.stroke();

    const reach = Math.max(0.6, spacing[axis]);
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const marker of markers) {
      if (Math.abs(marker.position[axis] - cursor[axis]) > reach) continue;
      const mx = sx(marker.position[h]), my = sy(marker.position[v]);
      ctx.beginPath();
      ctx.arc(mx, my, 8, 0, Math.PI * 2);
      ctx.fillStyle = marker.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(marker.label, mx, my + 0.5);
    }

    // 方位标注与读数
    ctx.fillStyle = 'rgba(226, 232, 240, 0.75)';
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillText(patientSide(volume, h, false), 14, height / 2);
    ctx.fillText(patientSide(volume, h, true), width - 14, height / 2);
    ctx.fillText(patientSide(volume, v, flipV), width / 2, 14);
    ctx.fillText(patientSide(volume, v, !flipV), width / 2, height - 14);

    ctx.textAlign = 'left';
    ctx.fillStyle = contourColor;
    ctx.fillRect(12, 12, 3, 14);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(title, 21, 19.5);
    ctx.fillStyle = 'rgba(203, 213, 225, 0.85)';
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(`${index + 1}/${dims[axis]} · ${(index * spacing[axis]).toFixed(1)} mm`, 12, height - 14);
    const value = voxelAt(volume, cursor[0], cursor[1], cursor[2]);
    if (value !== null) {
      ctx.textAlign = 'right';
      ctx.fillText(`${value} HU`, width - 12, height - 14);
    }
  };

  useEffect(() => { drawRef.current(); });

  useEffect(() => {
    const canvas = canvasRef.current!;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);

    const moveCursor = (event: PointerEvent) => {
      const { volume, axis, cursor, onCursorChange } = latest.current;
      const { h, v, flipV } = sliceAxes(axis);
      const rect = canvas.getBoundingClientRect();
      const { ox, oy, scale } = layout.current;
      const hm = (event.clientX - rect.left - ox) / scale - volume.spacing[h] / 2;
      const raw = (event.clientY - rect.top - oy) / scale - volume.spacing[v] / 2;
      const vMax = (volume.dims[v] - 1) * volume.spacing[v];
      const next: Vec3 = [cursor[0], cursor[1], cursor[2]];
      next[h] = clamp(hm, 0, (volume.dims[h] - 1) * volume.spacing[h]);
      next[v] = clamp(flipV ? vMax - raw : raw, 0, vMax);
      onCursorChange(next);
    };

    let drag: { mode: 'cursor' | 'pan'; x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      canvas.setPointerCapture(event.pointerId);
      drag = { mode: event.button === 0 && !event.shiftKey ? 'cursor' : 'pan', x: event.clientX, y: event.clientY };
      if (drag.mode === 'cursor') moveCursor(event);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag) return;
      if (drag.mode === 'cursor') {
        moveCursor(event);
      } else {
        view.current.panX += event.clientX - drag.x;
        view.current.panY += event.clientY - drag.y;
        drag.x = event.clientX;
        drag.y = event.clientY;
        drawRef.current();
      }
    };
    const onUp = () => { drag = null; };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        view.current.zoom = clamp(view.current.zoom * Math.exp(-event.deltaY * 0.004), 0.5, 12);
        drawRef.current();
        return;
      }
      const { volume, axis, cursor, onCursorChange } = latest.current;
      const step = volume.spacing[axis] * (event.deltaY > 0 ? -1 : 1);
      const next: Vec3 = [cursor[0], cursor[1], cursor[2]];
      next[axis] = clamp(cursor[axis] + step, 0, (volume.dims[axis] - 1) * volume.spacing[axis]);
      onCursorChange(next);
    };
    const onDoubleClick = () => {
      view.current = { zoom: 1, panX: 0, panY: 0 };
      drawRef.current();
    };
    const onContextMenu = (event: Event) => event.preventDefault();

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => {
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full cursor-crosshair touch-none"
      title="拖动移动十字线 · 滚轮翻层 · Ctrl/⌘ + 滚轮缩放 · Shift 或右键拖动平移 · 双击复位"
    />
  );
};
