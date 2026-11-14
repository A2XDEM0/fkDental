// 颜色全部指向 theme.css 里的变量，深浅色主题在那里切换；这里只做类名到变量的映射。
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const themed = variable => `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;
const scale = name => Object.fromEntries(SHADES.map(shade => [shade, themed(`--c-${name}-${shade}`)]));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './App.tsx',
    './components/**/*.{ts,tsx}',
    './features/**/*.{ts,tsx}',
    './modals/**/*.{ts,tsx}',
    './pages/**/*.{ts,tsx}',
    './utils/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        white: themed('--c-white'),
        slate: scale('slate'),
        teal: scale('teal'),
        red: scale('red'),
        rose: scale('red'),
        green: scale('green'),
        emerald: scale('green'),
        amber: scale('amber'),
        orange: scale('amber'),
        blue: scale('blue'),
        sky: scale('blue'),
        violet: scale('violet'),
        // v1.3.3 引入的陶土色点缀，这里并到暖色（amber）上。
        clay: scale('amber'),
        canvas: themed('--c-slate-50'),
        surface: themed('--c-white'),
        primary: themed('--c-primary'),
        'on-primary': themed('--c-on-primary')
      },
      fontFamily: {
        sans: ['"Google Sans Flex Variable"', '"Noto Sans SC Variable"', '"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"Google Sans Code Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      // Noto Sans SC 的 700 在界面里偏重，标题统一用 600。
      fontWeight: {
        bold: '600'
      },
      boxShadow: {
        clinic: '0 14px 34px rgb(0 0 0 / 0.12)'
      }
    }
  },
  plugins: []
};
