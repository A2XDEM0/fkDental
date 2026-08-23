import React, { useEffect, useMemo, useRef } from 'react';
import { TrendingUp, UsersRound } from 'lucide-react';
import { Patient } from '../types';
import { buildReportStats } from '../features/reports/reportStats';
import { buildAreaPath, buildLinePath, createAxisMapper, inverseScaleValue, transformScaleValue } from '../features/reports/chartMath';
import { ReportChartSettings } from '../features/reports/reportSettings';

type ChartSeries = {
  label: string;
  color: string;
  fillColor: string;
  values: number[];
  dashed?: boolean;
  tooltip: (index: number) => string;
};

const CHART_HEIGHT = 318;
const PLOT_TOP = 38;
const PLOT_BOTTOM = 260;
const Y_AXIS_WIDTH = 78;

const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const formatCurrency = (value: number) => currencyFormatter.format(value);

const formatRevenueTick = (value: number) => {
  const absolute = Math.abs(value);
  if (absolute >= 10000) {
    const scaled = value / 10000;
    return `¥${Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}万`;
  }
  return `¥${Math.abs(value) >= 100 ? Math.round(value).toLocaleString('zh-CN') : Number(value.toFixed(1)).toLocaleString('zh-CN')}`;
};

const formatTrafficTick = (value: number) => (
  `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)} 人`
);

const formatDateRange = (dates: string[]) => {
  if (dates.length === 0) return '';
  return dates.length === 1 ? dates[0] : `${dates[0]} — ${dates[dates.length - 1]}`;
};

const getMonthLabel = (monthKey: string, width: number) => {
  const [year, month] = monthKey.split('-').map(Number);
  if (width >= 92) return `${year}年${month}月`;
  if (width >= 36) return `${month}月`;
  return '';
};

const LineAreaChart = ({
  dates,
  series,
  settings,
  formatYAxis,
  emptyMessage,
  hasData,
  ariaLabel
}: {
  dates: string[];
  series: ChartSeries[];
  settings: ReportChartSettings;
  formatYAxis: (value: number) => string;
  emptyMessage: string;
  hasData: boolean;
  ariaLabel: string;
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const plotWidth = Math.max(860, dates.length * 8);
  const xStart = 12;
  const xEnd = plotWidth - 18;
  const values = series.flatMap(item => item.values).filter(Number.isFinite);
  let domainMin = 0;
  let domainMax = 0;
  values.forEach(value => {
    domainMin = Math.min(domainMin, value);
    domainMax = Math.max(domainMax, value);
  });
  if (domainMin === domainMax) domainMax = domainMin === 0 ? 1 : domainMin + Math.max(1, Math.abs(domainMin) * 0.1);

  const rawMapX = dates.length <= 1
    ? null
    : createAxisMapper(1, dates.length, xStart, xEnd, settings.xScale, settings.powerExponent);
  const mapX = (index: number) => rawMapX ? rawMapX(index + 1) : plotWidth / 2;
  const mapY = createAxisMapper(
    domainMin,
    domainMax,
    PLOT_BOTTOM,
    PLOT_TOP,
    settings.yScale,
    settings.powerExponent
  );

  const transformedMin = transformScaleValue(domainMin, settings.yScale, settings.powerExponent);
  const transformedMax = transformScaleValue(domainMax, settings.yScale, settings.powerExponent);
  const yTicks = Array.from({ length: 5 }, (_, index) => {
    const transformed = transformedMin + ((transformedMax - transformedMin) * index) / 4;
    const rawValue = inverseScaleValue(transformed, settings.yScale, settings.powerExponent);
    return { value: Math.abs(rawValue) < 1e-9 ? 0 : rawValue, y: mapY(rawValue) };
  });

  const monthBands = useMemo(() => {
    const starts: Array<{ month: string; index: number }> = [];
    dates.forEach((date, index) => {
      const month = date.slice(0, 7);
      if (starts[starts.length - 1]?.month !== month) starts.push({ month, index });
    });
    return starts.map((item, bandIndex) => {
      const nextIndex = starts[bandIndex + 1]?.index;
      const left = item.index === 0 ? 0 : (mapX(item.index - 1) + mapX(item.index)) / 2;
      const right = nextIndex === undefined ? plotWidth : (mapX(nextIndex - 1) + mapX(nextIndex)) / 2;
      return { ...item, left, right };
    });
  }, [dates, mapX, plotWidth]);

  const dayLabels = useMemo(() => {
    let lastX = -Infinity;
    return dates.flatMap((date, index) => {
      const day = Number(date.slice(8, 10));
      if (![1, 8, 15, 22].includes(day)) return [];
      const x = mapX(index);
      if (x - lastX < 34) return [];
      lastX = x;
      return [{ date, day, x }];
    });
  }, [dates, mapX]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dates.length, plotWidth, settings.powerExponent, settings.xScale]);

  const dailyTickStride = Math.max(1, Math.ceil(dates.length / 700));
  const hoverTargetStride = Math.max(1, Math.ceil(dates.length / 1200));

  return (
    <div className="relative border-t border-slate-100 bg-white">
      <svg
        className="pointer-events-none absolute left-0 top-0 z-20 bg-gradient-to-r from-white via-white to-white/80"
        width={Y_AXIS_WIDTH}
        height={CHART_HEIGHT}
        viewBox={`0 0 ${Y_AXIS_WIDTH} ${CHART_HEIGHT}`}
        aria-hidden="true"
      >
        {yTicks.map(tick => (
          <g key={tick.y}>
            <text x="66" y={tick.y + 4} textAnchor="end" className="fill-slate-500 text-[11px] font-medium">
              {formatYAxis(tick.value)}
            </text>
            <line x1="70" x2="78" y1={tick.y} y2={tick.y} stroke="#cbd5e1" />
          </g>
        ))}
        <line x1="77.5" x2="77.5" y1={PLOT_TOP} y2={PLOT_BOTTOM} stroke="#cbd5e1" />
      </svg>

      <div
        ref={scrollRef}
        className="overflow-x-auto pl-[78px] [scrollbar-color:#cbd5e1_transparent] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-teal-500"
        role="region"
        tabIndex={0}
        aria-label={`${ariaLabel}，可使用左右方向键横向滚动`}
      >
        <svg
          width={plotWidth}
          height={CHART_HEIGHT}
          viewBox={`0 0 ${plotWidth} ${CHART_HEIGHT}`}
          role="img"
          aria-label={ariaLabel}
        >
          {monthBands.map((band, index) => (
            <g key={band.month}>
              <rect
                x={band.left}
                y="18"
                width={Math.max(0, band.right - band.left)}
                height={PLOT_BOTTOM - 18}
                fill={index % 2 === 0 ? '#ffffff' : '#f8fafc'}
              />
              <line x1={band.left} x2={band.left} y1="18" y2={PLOT_BOTTOM} stroke="#cbd5e1" strokeDasharray="3 5" />
              {getMonthLabel(band.month, band.right - band.left) && (
                <text
                  x={(band.left + band.right) / 2}
                  y="13"
                  textAnchor="middle"
                  className="fill-slate-700 text-[12px] font-bold"
                >
                  {getMonthLabel(band.month, band.right - band.left)}
                </text>
              )}
            </g>
          ))}

          {yTicks.map(tick => (
            <line
              key={tick.y}
              x1="0"
              x2={plotWidth}
              y1={tick.y}
              y2={tick.y}
              stroke={tick.value === 0 ? '#94a3b8' : '#e2e8f0'}
              strokeWidth={tick.value === 0 ? 1.2 : 1}
            />
          ))}

          {dates.map((date, index) => index % dailyTickStride === 0 && (
            <line
              key={date}
              x1={mapX(index)}
              x2={mapX(index)}
              y1={PLOT_BOTTOM}
              y2={PLOT_BOTTOM + 4}
              stroke="#cbd5e1"
            />
          ))}

          {series.map(item => (
            <path
              key={`${item.label}-area`}
              d={buildAreaPath(item.values, mapX, mapY)}
              fill={item.fillColor}
              fillOpacity="0.2"
              stroke="none"
            />
          ))}

          {series.map(item => (
            <path
              key={`${item.label}-line`}
              d={buildLinePath(item.values, mapX, mapY)}
              fill="none"
              stroke={item.color}
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={item.dashed ? '10 8' : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {dates.length <= 160 && series.map(item => item.values.map((value, index) => (
            <circle
              key={`${item.label}-${dates[index]}`}
              cx={mapX(index)}
              cy={mapY(value)}
              r="2.8"
              fill={item.color}
              stroke="white"
              strokeWidth="1.5"
            >
              <title>{`${dates[index]} · ${item.tooltip(index)}`}</title>
            </circle>
          )))}

          {dates.length > 160 && series.map(item => item.values.map((value, index) => (
            (index % hoverTargetStride === 0 || index === dates.length - 1) ? (
              <circle
                key={`${item.label}-target-${dates[index]}`}
                cx={mapX(index)}
                cy={mapY(value)}
                r="7"
                fill="transparent"
              >
                <title>{`${dates[index]} · ${item.tooltip(index)}`}</title>
              </circle>
            ) : null
          )))}

          <line x1="0" x2={plotWidth} y1={PLOT_BOTTOM} y2={PLOT_BOTTOM} stroke="#cbd5e1" />
          {dayLabels.map(label => (
            <text
              key={label.date}
              x={label.x}
              y={PLOT_BOTTOM + 20}
              textAnchor="middle"
              className="fill-slate-400 text-[10px]"
            >
              {label.day}日
            </text>
          ))}
        </svg>
      </div>

      {!hasData && (
        <div className="pointer-events-none absolute inset-x-24 top-[116px] z-30 flex justify-center">
          <div className="rounded-full border border-slate-200 bg-white/90 px-5 py-2 text-sm font-medium text-slate-400 shadow-sm">
            {emptyMessage}
          </div>
        </div>
      )}
    </div>
  );
};

const SeriesLegend = ({ series }: { series: ChartSeries[] }) => (
  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-600">
    {series.map(item => (
      <div key={item.label} className="flex items-center gap-2">
        <span
          className="block w-8 border-t-[3px]"
          style={{ borderColor: item.color, borderTopStyle: item.dashed ? 'dashed' : 'solid' }}
        />
        <span className="font-medium">{item.label}</span>
      </div>
    ))}
  </div>
);

const ChartCard = ({
  icon,
  title,
  dates,
  series,
  settings,
  formatYAxis,
  emptyMessage,
  hasData,
  ariaLabel
}: {
  icon: React.ReactNode;
  title: string;
  dates: string[];
  series: ChartSeries[];
  settings: ReportChartSettings;
  formatYAxis: (value: number) => string;
  emptyMessage: string;
  hasData: boolean;
  ariaLabel: string;
}) => (
  <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
    <div className="flex flex-col gap-4 px-6 py-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-slate-100 p-2.5 text-slate-700">{icon}</div>
        <div>
          <h2 className="text-xl font-bold text-slate-900">{title}</h2>
          <p className="mt-1 font-mono text-xs text-slate-400">{formatDateRange(dates)}</p>
        </div>
      </div>
      <SeriesLegend series={series} />
    </div>
    <LineAreaChart
      dates={dates}
      series={series}
      settings={settings}
      formatYAxis={formatYAxis}
      emptyMessage={emptyMessage}
      hasData={hasData}
      ariaLabel={ariaLabel}
    />
  </section>
);

export const Reports = ({ patients, chartSettings }: { patients: Patient[]; chartSettings: ReportChartSettings }) => {
  const stats = useMemo(() => buildReportStats(patients), [patients]);
  const revenueSeries = useMemo<ChartSeries[]>(() => [{
    label: '每日收入',
    color: '#8b5cf6',
    fillColor: '#a78bfa',
    values: stats.revenueDays.map(day => day.revenue),
    tooltip: index => `收入 ${formatCurrency(stats.revenueDays[index].revenue)}`
  }], [stats.revenueDays]);
  const trafficSeries = useMemo<ChartSeries[]>(() => [
    {
      label: '每日客流',
      color: '#06b6d4',
      fillColor: '#22d3ee',
      values: stats.trafficDays.map(day => day.visits),
      tooltip: index => {
        const day = stats.trafficDays[index];
        return `客流 ${day.visits} 人次（初诊 ${day.initialVisits} · 复诊 ${day.followUpVisits}）`;
      }
    },
    {
      label: `平均客流 ${stats.averageDailyVisits.toFixed(1)} 人/日`,
      color: '#f97316',
      fillColor: '#fb923c',
      values: stats.trafficDays.map(() => stats.averageDailyVisits),
      dashed: true,
      tooltip: () => `区间平均 ${stats.averageDailyVisits.toFixed(2)} 人/日`
    }
  ], [stats.averageDailyVisits, stats.trafficDays]);

  return (
    <div className="mx-auto w-full max-w-[1600px] p-6 lg:p-8">
      <header className="mb-7">
        <h1 className="text-3xl font-bold text-slate-900">统计报表</h1>
      </header>

      <div className="space-y-7">
        <ChartCard
          icon={<TrendingUp size={22} className="text-violet-600" />}
          title="收入随日期变化"
          dates={stats.revenueDays.map(day => day.date)}
          series={revenueSeries}
          settings={chartSettings}
          formatYAxis={formatRevenueTick}
          emptyMessage="暂无收入记录"
          hasData={stats.revenueDays.some(day => day.revenue !== 0)}
          ariaLabel="收入随日期变化折线图"
        />

        <ChartCard
          icon={<UsersRound size={22} className="text-cyan-600" />}
          title="每日客流与平均客流"
          dates={stats.trafficDays.map(day => day.date)}
          series={trafficSeries}
          settings={chartSettings}
          formatYAxis={formatTrafficTick}
          emptyMessage="暂无初诊或复诊接诊记录"
          hasData={stats.totalVisits > 0}
          ariaLabel="每日客流与平均客流对比折线图"
        />
      </div>
    </div>
  );
};
