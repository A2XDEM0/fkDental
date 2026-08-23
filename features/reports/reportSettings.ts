export type ReportAxisScale = 'linear' | 'log' | 'power';

export type ReportChartSettings = {
  xScale: ReportAxisScale;
  yScale: ReportAxisScale;
  powerExponent: number;
};

export const REPORT_CHART_SETTINGS_KEY = 'dental_report_chart_settings_v1';

export const DEFAULT_REPORT_CHART_SETTINGS: ReportChartSettings = {
  xScale: 'linear',
  yScale: 'linear',
  powerExponent: 2
};

const isScale = (value: unknown): value is ReportAxisScale => (
  value === 'linear' || value === 'log' || value === 'power'
);

export const normalizeReportChartSettings = (value: Partial<ReportChartSettings> | null | undefined): ReportChartSettings => ({
  xScale: isScale(value?.xScale) ? value.xScale : DEFAULT_REPORT_CHART_SETTINGS.xScale,
  yScale: isScale(value?.yScale) ? value.yScale : DEFAULT_REPORT_CHART_SETTINGS.yScale,
  powerExponent: Math.min(5, Math.max(0.1, Number(value?.powerExponent) || DEFAULT_REPORT_CHART_SETTINGS.powerExponent))
});

export const loadReportChartSettings = () => {
  if (typeof window === 'undefined') return DEFAULT_REPORT_CHART_SETTINGS;
  try {
    const stored = window.localStorage.getItem(REPORT_CHART_SETTINGS_KEY);
    return normalizeReportChartSettings(stored ? JSON.parse(stored) : null);
  } catch (error) {
    console.error('Failed to parse report chart settings', error);
    return DEFAULT_REPORT_CHART_SETTINGS;
  }
};

export const saveReportChartSettings = (settings: ReportChartSettings) => {
  const normalized = normalizeReportChartSettings(settings);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(REPORT_CHART_SETTINGS_KEY, JSON.stringify(normalized));
    } catch (error) {
      console.error('Failed to save report chart settings', error);
    }
  }
  return normalized;
};

export const REPORT_AXIS_SCALE_LABELS: Record<ReportAxisScale, string> = {
  linear: '线性',
  log: '对数',
  power: '幂函数'
};
