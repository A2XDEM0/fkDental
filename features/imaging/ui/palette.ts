// 影像工作台的配色约定。

// 标记点配对：分类色，固定顺序，同时配有编号，不单靠颜色区分。
export const LANDMARK_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
export const MAX_LANDMARKS = LANDMARK_COLORS.length;

export const IOS_COLOR = '#2dd4bf';      // 口扫在融合视图和切面轮廓里统一用品牌青色
export const IOS_STONE_COLOR = '#d8d2c6'; // 口扫单独显示且没有顶点色时的石膏色
export const CT_COLOR = '#e8dfcf';

// 表面偏差：单一色相、由浅到深的顺序色标；没有对应面的区域用中性灰蓝。
export const DEVIATION_RAMP = ['#fbe6d8', '#f6c7a8', '#f0a274', '#e87c43', '#d95926', '#b1431a', '#8a3110'];
export const DEVIATION_NONE = '#566174';
export const DEVIATION_MAX_MM = 1;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexToLinear = (hex: string) => [1, 3, 5].map(i => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));

export const srgbArrayToLinear = (colors: Float32Array) => {
  const out = new Float32Array(colors.length);
  for (let i = 0; i < colors.length; i++) out[i] = srgbToLinear(colors[i]);
  return out;
};

// 把逐顶点偏差（毫米，-1 表示无对应面）映射成 three.js 需要的线性 RGB 顶点色。
export const deviationToColors = (distances: Float32Array) => {
  const stops = DEVIATION_RAMP.map(hexToLinear);
  const none = hexToLinear(DEVIATION_NONE);
  const colors = new Float32Array(distances.length * 3);
  for (let i = 0; i < distances.length; i++) {
    const d = distances[i];
    let rgb = none;
    if (d >= 0) {
      const t = Math.min(1, d / DEVIATION_MAX_MM) * (stops.length - 1);
      const lo = Math.min(stops.length - 2, Math.floor(t));
      const f = t - lo;
      rgb = [0, 1, 2].map(c => stops[lo][c] + (stops[lo + 1][c] - stops[lo][c]) * f);
    }
    colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
  }
  return colors;
};
