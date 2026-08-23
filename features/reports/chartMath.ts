import { ReportAxisScale } from './reportSettings';

export const transformScaleValue = (value: number, scale: ReportAxisScale, exponent: number) => {
  if (scale === 'log') return Math.sign(value) * Math.log1p(Math.abs(value));
  if (scale === 'power') return Math.sign(value) * Math.pow(Math.abs(value), exponent);
  return value;
};

export const inverseScaleValue = (value: number, scale: ReportAxisScale, exponent: number) => {
  if (scale === 'log') return Math.sign(value) * Math.expm1(Math.abs(value));
  if (scale === 'power') return Math.sign(value) * Math.pow(Math.abs(value), 1 / exponent);
  return value;
};

export const createAxisMapper = (
  domainStart: number,
  domainEnd: number,
  rangeStart: number,
  rangeEnd: number,
  scale: ReportAxisScale,
  exponent: number
) => {
  const transformedStart = transformScaleValue(domainStart, scale, exponent);
  const transformedEnd = transformScaleValue(domainEnd, scale, exponent);
  const span = transformedEnd - transformedStart;
  if (!Number.isFinite(span) || span === 0) return () => (rangeStart + rangeEnd) / 2;
  return (value: number) => {
    const transformed = transformScaleValue(value, scale, exponent);
    return rangeStart + ((transformed - transformedStart) / span) * (rangeEnd - rangeStart);
  };
};

export const buildLinePath = (
  values: number[],
  mapX: (index: number) => number,
  mapY: (value: number) => number
) => values.map((value, index) => (
  `${index === 0 ? 'M' : 'L'} ${mapX(index).toFixed(2)} ${mapY(value).toFixed(2)}`
)).join(' ');

export const buildAreaPath = (
  values: number[],
  mapX: (index: number) => number,
  mapY: (value: number) => number,
  baselineValue = 0
) => {
  if (values.length === 0) return '';
  const firstX = mapX(0).toFixed(2);
  const lastX = mapX(values.length - 1).toFixed(2);
  const baselineY = mapY(baselineValue).toFixed(2);
  return `M ${firstX} ${baselineY} ${values.map((value, index) => (
    `L ${mapX(index).toFixed(2)} ${mapY(value).toFixed(2)}`
  )).join(' ')} L ${lastX} ${baselineY} Z`;
};
