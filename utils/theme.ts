export type Theme = 'light' | 'dark';

const THEME_KEY = 'dentalThemePreference';

// 没有手动切换过时，取启动那一刻的系统外观；之后只在浅色和深色之间切换。
export const getTheme = (): Theme => {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

// 界面主题是本机的显示偏好，不属于诊所数据，不进数据库也不参与云同步。
export const setTheme = (theme: Theme) => {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
};

export const initializeTheme = () => {
  document.documentElement.dataset.theme = getTheme();
};
