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
        // B 风格：用暖米色中性取代冷灰，并让深色阶自然过渡到森林绿侧栏。
        slate: {
          50: '#F7F3EC',
          100: '#EFE8DE',
          200: '#E3D9CC',
          300: '#CFC2B2',
          400: '#9A9187',
          500: '#756D64',
          600: '#5D5851',
          700: '#48453F',
          800: '#303C37',
          900: '#1F2F2B',
          950: '#111C19',
        },
        // 现有 teal 类继续作为品牌语义使用，但实际呈现为更温润的森林绿。
        teal: {
          50: '#EFF6F2',
          100: '#DDECE4',
          200: '#BFD8CC',
          300: '#91BBA7',
          400: '#639A83',
          500: '#3E806B',
          600: '#176B5B',
          700: '#14594C',
          800: '#12483E',
          900: '#103B34',
          950: '#08231E',
        },
        clay: {
          50: '#FFF4EF',
          100: '#FFE6DA',
          200: '#F7CDBB',
          300: '#EFA889',
          400: '#E58B66',
          500: '#D97757',
          600: '#C86143',
          700: '#A84D34',
          800: '#883F30',
          900: '#70372C',
          950: '#3C1B16',
        },
        sage: {
          50: '#F4F7F3',
          100: '#E6EEE8',
          200: '#CCDCCF',
          300: '#AAC5B0',
          400: '#8FAF9F',
          500: '#6E9380',
          600: '#577767',
          700: '#465F53',
          800: '#3B4E45',
          900: '#334139',
          950: '#19231F',
        },
        canvas: '#F7F3EC',
        surface: '#FFFDF9',
      },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        clinic: '0 14px 34px rgba(36, 63, 58, 0.12)',
      },
    }
  },
  plugins: []
};
