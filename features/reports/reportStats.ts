import { Patient, PatientActivityType } from '../../types';
import { formatDateKey, getLocalDateKeyFromTimestamp } from '../../utils/date';

export type DailyRevenuePoint = {
  date: string;
  revenue: number;
};

export type WeeklyRevenuePoint = {
  weekStart: string;
  weekEnd: string;
  revenue: number;
};

export type DailyTrafficPoint = {
  date: string;
  visits: number;
  initialVisits: number;
  followUpVisits: number;
};

export type RevenueDetailRow = {
  key: string;
  patientId: string;
  patientName: string;
  phone: string;
  treatmentId: string;
  date: string;
  createdAt?: string;
  item: string;
  revenue: number;
  includedInChart: boolean;
};

export type ReportStats = {
  revenueDays: DailyRevenuePoint[];
  revenueWeeks: WeeklyRevenuePoint[];
  trafficDays: DailyTrafficPoint[];
  totalRevenue: number;
  totalVisits: number;
  averageDailyVisits: number;
  revenueDetails: RevenueDetailRow[];
  revenueHistoryTruncated: boolean;
  trafficHistoryTruncated: boolean;
};

type VisitKind = Extract<PatientActivityType, 'initial_visit' | 'follow_up_visit'>;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_DAYS = 3660;

const toFiniteNumber = (value: number) => Number.isFinite(value) ? value : 0;

const dateKeyToDayNumber = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return Math.floor(timestamp / DAY_MS);
};

const dayNumberToDateKey = (dayNumber: number) => {
  const date = new Date(dayNumber * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const getMondayDayNumber = (dayNumber: number) => {
  const weekday = new Date(dayNumber * DAY_MS).getUTCDay();
  return dayNumber - ((weekday + 6) % 7);
};

export const aggregateRevenueByWeek = (days: DailyRevenuePoint[]): WeeklyRevenuePoint[] => {
  const validDays = days
    .flatMap(day => {
      const dayNumber = dateKeyToDayNumber(day.date);
      return dayNumber === null ? [] : [{ ...day, dayNumber }];
    })
    .sort((a, b) => a.dayNumber - b.dayNumber);
  if (validDays.length === 0) return [];

  const revenueByWeekStart = new Map<number, number>();
  validDays.forEach(day => {
    const weekStart = getMondayDayNumber(day.dayNumber);
    revenueByWeekStart.set(weekStart, (revenueByWeekStart.get(weekStart) || 0) + day.revenue);
  });

  const firstWeekStart = getMondayDayNumber(validDays[0].dayNumber);
  const lastObservedDay = validDays[validDays.length - 1].dayNumber;
  const lastWeekStart = getMondayDayNumber(lastObservedDay);
  const weeks: WeeklyRevenuePoint[] = [];
  for (let weekStart = firstWeekStart; weekStart <= lastWeekStart; weekStart += 7) {
    weeks.push({
      weekStart: dayNumberToDateKey(weekStart),
      weekEnd: dayNumberToDateKey(Math.min(weekStart + 6, lastObservedDay)),
      revenue: revenueByWeekStart.get(weekStart) || 0,
    });
  }
  return weeks;
};

const enumerateDateKeys = (firstObservedDate: string | undefined, today: string) => {
  const todayDayNumber = dateKeyToDayNumber(today)!;
  const observedDayNumber = firstObservedDate ? dateKeyToDayNumber(firstObservedDate) : null;
  const requestedStartDayNumber = observedDayNumber === null
    ? dateKeyToDayNumber(`${today.slice(0, 7)}-01`)!
    : Math.min(observedDayNumber, todayDayNumber);
  const earliestAllowedDayNumber = todayDayNumber - MAX_REPORT_DAYS + 1;
  const startDayNumber = Math.max(requestedStartDayNumber, earliestAllowedDayNumber);

  return {
    dates: Array.from(
      { length: todayDayNumber - startDayNumber + 1 },
      (_, index) => dayNumberToDateKey(startDayNumber + index)
    ),
    truncated: requestedStartDayNumber < startDayNumber
  };
};

const earliestDate = (dates: Iterable<string>, today: string) => {
  let earliest: string | undefined;
  for (const date of dates) {
    if (date > today || dateKeyToDayNumber(date) === null) continue;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest;
};

export const buildReportStats = (patients: Patient[], now = new Date()): ReportStats => {
  const today = formatDateKey(now);
  const todayDayNumber = dateKeyToDayNumber(today)!;
  const earliestChartDayNumber = todayDayNumber - MAX_REPORT_DAYS + 1;
  const revenueByDate = new Map<string, number>();
  const revenueDetails: RevenueDetailRow[] = [];

  patients.forEach(patient => {
    patient.treatments.forEach(treatment => {
      const revenue = toFiniteNumber(treatment.price);
      const treatmentDayNumber = dateKeyToDayNumber(treatment.date);
      const includedInChart = treatmentDayNumber !== null
        && treatmentDayNumber >= earliestChartDayNumber
        && treatmentDayNumber <= todayDayNumber;
      revenueDetails.push({
        key: `${patient.id}:${treatment.id}`,
        patientId: patient.id,
        patientName: patient.name,
        phone: patient.phone,
        treatmentId: treatment.id,
        date: treatment.date,
        createdAt: treatment.createdAt,
        item: treatment.item || '未命名处置',
        revenue,
        includedInChart
      });
      if (treatmentDayNumber !== null && treatmentDayNumber <= todayDayNumber) {
        revenueByDate.set(treatment.date, (revenueByDate.get(treatment.date) || 0) + revenue);
      }
    });
  });

  revenueDetails.sort((a, b) => (
    b.date.localeCompare(a.date)
    || (b.createdAt || '').localeCompare(a.createdAt || '')
    || a.patientName.localeCompare(b.patientName, 'zh-CN')
  ));

  // 客流按患者和自然日去重；重复点击“到诊”不会把同一位患者重复计入当日客流。
  const visitKindsByPatientDate = new Map<string, Set<VisitKind>>();
  patients.forEach(patient => {
    const addVisit = (date: string, kind: VisitKind) => {
      if (dateKeyToDayNumber(date) === null || date > today) return;
      const key = `${patient.id}:${date}`;
      const kinds = visitKindsByPatientDate.get(key) || new Set<VisitKind>();
      kinds.add(kind);
      visitKindsByPatientDate.set(key, kinds);
    };

    (patient.activityLog || []).forEach(activity => {
      if (activity.type !== 'initial_visit' && activity.type !== 'follow_up_visit') return;
      addVisit(getLocalDateKeyFromTimestamp(activity.occurredAt), activity.type);
    });

    // 到诊快照作为兼容数据源；与活动日志按“患者 + 日期”去重，避免正常预约双计。
    patient.appointments.forEach(appointment => {
      if (
        !appointment.checkedInAt
        || (appointment.status !== 'arrived' && appointment.status !== 'completed')
        || (appointment.visitType !== 'initial' && appointment.visitType !== 'follow_up')
      ) return;
      addVisit(
        getLocalDateKeyFromTimestamp(appointment.checkedInAt),
        appointment.visitType === 'initial' ? 'initial_visit' : 'follow_up_visit'
      );
    });
  });

  const trafficByDate = new Map<string, { initialVisits: number; followUpVisits: number }>();
  visitKindsByPatientDate.forEach((kinds, key) => {
    const date = key.slice(key.lastIndexOf(':') + 1);
    const current = trafficByDate.get(date) || { initialVisits: 0, followUpVisits: 0 };
    // 同一患者同日若异常出现两种记录，仍只算 1 人次，并优先归为初诊。
    if (kinds.has('initial_visit')) current.initialVisits += 1;
    else current.followUpVisits += 1;
    trafficByDate.set(date, current);
  });

  const revenueRange = enumerateDateKeys(earliestDate(revenueByDate.keys(), today), today);
  const trafficRange = enumerateDateKeys(earliestDate(trafficByDate.keys(), today), today);
  const revenueDays = revenueRange.dates.map(date => ({
    date,
    revenue: revenueByDate.get(date) || 0
  }));
  const revenueWeeks = aggregateRevenueByWeek(revenueDays);
  const trafficDays = trafficRange.dates.map(date => {
    const counts = trafficByDate.get(date) || { initialVisits: 0, followUpVisits: 0 };
    return {
      date,
      visits: counts.initialVisits + counts.followUpVisits,
      ...counts
    };
  });
  const totalVisits = trafficDays.reduce((sum, day) => sum + day.visits, 0);

  return {
    revenueDays,
    revenueWeeks,
    trafficDays,
    totalRevenue: revenueDetails.reduce((sum, detail) => sum + detail.revenue, 0),
    totalVisits,
    averageDailyVisits: trafficDays.length > 0 ? totalVisits / trafficDays.length : 0,
    revenueDetails,
    revenueHistoryTruncated: revenueRange.truncated,
    trafficHistoryTruncated: trafficRange.truncated
  };
};
