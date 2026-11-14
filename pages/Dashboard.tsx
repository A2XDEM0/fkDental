import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarPlus, CheckCircle, ChevronRight, Circle, Plus, Search, UserPlus, XCircle } from 'lucide-react';
import { clinicService } from '../services/clinicService';
import { GlobalAppointment, Patient, PatientListItem } from '../types';
import { View } from '../appTypes';
import { formatDateKey } from '../utils/date';
import { buildTreatmentContributionDays, getContributionColor, TreatmentContribution } from '../features/contribution/contribution';
import { Button } from '../components/Button';
import { AddAppointmentModal } from '../modals/AddAppointmentModal';
import { AddPatientModal } from '../modals/AddPatientModal';
import { getAppointmentStatusClass, getAppointmentStatusLabel } from '../utils/statusStyles';

const SEARCH_RESULT_LIMIT = 6;
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];

const getGreeting = (hour: number) => {
  if (hour < 5) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
};

export const Dashboard = ({ patients, onViewChange, onPatientClick, onRefresh, clinicName, searchFocusToken }: {
  patients: Patient[],
  onViewChange: (v: View) => void,
  onPatientClick: (id: string) => void,
  onRefresh: () => void,
  clinicName: string,
  searchFocusToken: number
}) => {
  const [showAppointmentModal, setShowAppointmentModal] = useState(false);
  const [showPatientModal, setShowPatientModal] = useState(false);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<PatientListItem[] | null>(null);
  const [resultsQuery, setResultsQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const searchInput = useRef<HTMLInputElement | null>(null);
  const enterPending = useRef(false);
  const now = new Date();
  const today = formatDateKey(now);
  const todayAppts = clinicService.getAppointmentsByDate(today);
  const contribution = useMemo(() => buildTreatmentContributionDays(patients), [patients]);
  const query = search.trim();

  useEffect(() => {
    searchInput.current?.focus();
  }, [searchFocusToken]);

  // 搜索沿用患者列表的查询接口（姓名、电话、拼音），只取前几条。患者数据变了（比如刚新增）也要重查。
  useEffect(() => {
    if (!query) {
      setResults(null);
      setResultsQuery('');
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      clinicService.getPatientListPage({ query, scope: 'all', offset: 0, limit: SEARCH_RESULT_LIMIT })
        .then(page => {
          if (cancelled) return;
          setResults(page.items);
          setResultsQuery(query);
          setActiveIndex(0);
          // 结果还没回来时就按了回车：现在补上，打开这次查询的第一位。
          if (enterPending.current) {
            enterPending.current = false;
            if (page.items.length) onPatientClick(page.items[0].id);
          }
        })
        .catch(() => {
          if (cancelled) return;
          enterPending.current = false;
          setResults([]);
          setResultsQuery(query);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, patients]);

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      enterPending.current = false;
      setSearch('');
      return;
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      // 列表还是上一个关键词的结果时不能照着它开，等这次查询回来再说。
      if (resultsQuery !== query) enterPending.current = !!query;
      else if (results?.length) onPatientClick(results[activeIndex].id);
      return;
    }
    if (!results?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(index => (index + step + results.length) % results.length);
    }
  };

  const toggleStatus = (e: React.MouseEvent, appt: GlobalAppointment) => {
    e.stopPropagation();
    if (appt.status === 'cancelled') return;
    const newStatus = appt.status === 'pending' ? 'arrived' : 'completed';
    clinicService.updateAppointmentStatus(appt.id, newStatus);
    onRefresh();
  };

  const chipClass = 'inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm text-slate-700 transition-colors hover:bg-slate-100';

  return (
    <div className="mx-auto w-full max-w-3xl px-8 pb-16 pt-[11vh]">
      <header className="text-center">
        <h1 className="text-4xl font-normal tracking-tight text-slate-900">{getGreeting(now.getHours())}，{clinicName}</h1>
        <p className="mt-3 text-slate-500">
          {now.getMonth() + 1} 月 {now.getDate()} 日 · 星期{WEEKDAY_LABELS[now.getDay()]} · {todayAppts.length > 0 ? `今天有 ${todayAppts.length} 个预约` : '今天还没有预约'}
        </p>
      </header>

      <div className="mt-8 rounded-[28px] border border-slate-200 bg-white shadow-sm transition-shadow focus-within:border-slate-300 focus-within:shadow-md">
        <label className="flex items-center gap-3 px-5 pt-4">
          <Search size={20} className="flex-shrink-0 text-slate-400" />
          <input
            ref={searchInput}
            value={search}
            onChange={event => { enterPending.current = false; setSearch(event.target.value); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索患者姓名、电话或拼音首字母"
            aria-label="搜索患者"
            className="h-10 min-w-0 flex-1 bg-transparent text-lg text-slate-900 placeholder:text-slate-400 focus:outline-none"
          />
        </label>

        {results && (
          <div className="mt-2 border-t border-slate-100 px-2 py-2">
            {results.length === 0 ? (
              <div className="px-3 py-3 text-sm text-slate-500">没有找到“{query}”，可以直接新增这位患者。</div>
            ) : results.map((patient, index) => (
              <button
                key={patient.id}
                type="button"
                onClick={() => onPatientClick(patient.id)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left transition-colors ${index === activeIndex ? 'bg-slate-100' : ''}`}
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-teal-100 text-sm font-medium text-teal-800">{patient.name.charAt(0)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-slate-900">{patient.name}</span>
                  <span className="block truncate text-sm text-slate-500">{[patient.gender, patient.age && `${patient.age} 岁`, patient.phone].filter(Boolean).join(' · ') || '未填写资料'}</span>
                </span>
                {patient.isTodayVisit && <span className="rounded-full bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700">今日到诊</span>}
                <ChevronRight size={16} className="flex-shrink-0 text-slate-400" />
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-1 px-3 pb-3 pt-2">
          <button type="button" onClick={() => setShowPatientModal(true)} className={chipClass}>
            <UserPlus size={16} className="text-teal-600" /> 新增患者
          </button>
          <button type="button" onClick={() => setShowAppointmentModal(true)} className={chipClass}>
            <CalendarPlus size={16} className="text-teal-600" /> 新建预约
          </button>
          <span className="ml-auto pr-2 font-mono text-xs text-slate-400">{navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</span>
        </div>
      </div>

      <div className="mt-10 grid grid-cols-3 gap-3">
        <StatTile label="今日预约" value={todayAppts.length} onClick={() => onViewChange('schedule')} />
        <StatTile label="患者总数" value={patients.length} onClick={() => onViewChange('patients')} />
        <StatTile label="近 26 周处置" value={contribution.total} onClick={() => onViewChange('reports')} />
      </div>

      <section className="mt-10">
        <div className="mb-3 flex items-center justify-between gap-3 px-1">
          <h2 className="text-sm font-medium text-slate-500">今日预约</h2>
          <button type="button" onClick={() => onViewChange('schedule')} className="text-sm text-slate-500 transition-colors hover:text-slate-900">查看日程</button>
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200">
          {todayAppts.length === 0 ? (
            <div className="flex flex-col items-center px-6 py-10">
              <p className="text-slate-500">今日暂无预约</p>
              <Button className="mt-4" onClick={() => setShowAppointmentModal(true)}>
                <Plus size={16} className="mr-2" /> 新建预约
              </Button>
            </div>
          ) : todayAppts.map(appt => (
            <div
              key={appt.id}
              className="flex cursor-pointer items-center gap-4 border-b border-slate-100 px-5 py-3 transition-colors last:border-b-0 hover:bg-slate-50"
              onClick={() => onPatientClick(appt.patientId)}
            >
              <span className="w-14 flex-shrink-0 font-mono text-sm text-slate-600">{appt.time}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-slate-900">{appt.name}</span>
                <span className="block truncate text-sm text-slate-500">{appt.phone || '未填写电话'}</span>
              </span>
              <button
                onClick={(e) => toggleStatus(e, appt)}
                disabled={appt.status === 'cancelled'}
                title="点击切换状态"
                className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium transition-colors disabled:cursor-not-allowed ${getAppointmentStatusClass(appt.status)}`}
              >
                {appt.status === 'completed' ? <CheckCircle size={14}/> : appt.status === 'cancelled' ? <XCircle size={14}/> : <Circle size={14}/>}
                {getAppointmentStatusLabel(appt.status)}
              </button>
            </div>
          ))}
        </div>
      </section>

      <TreatmentContributionWall contribution={contribution} />

      {showAppointmentModal && (
        <AddAppointmentModal
          patients={patients}
          defaultDate={today}
          onClose={() => setShowAppointmentModal(false)}
          onSuccess={() => { setShowAppointmentModal(false); onRefresh(); }}
        />
      )}

      {showPatientModal && (
        <AddPatientModal
          patients={patients}
          onSelectPatient={patientId => { setShowPatientModal(false); onPatientClick(patientId); }}
          onClose={() => setShowPatientModal(false)}
          onSuccess={() => { setShowPatientModal(false); onRefresh(); }}
        />
      )}
    </div>
  );
};

const StatTile = ({ label, value, onClick }: { label: string; value: number; onClick: () => void }) => (
  <button type="button" onClick={onClick} className="rounded-2xl border border-slate-200 px-5 py-4 text-left transition-colors hover:bg-slate-50">
    <div className="text-sm text-slate-500">{label}</div>
    <div className="mt-1 text-3xl font-medium text-slate-900">{value}</div>
  </button>
);

const TreatmentContributionWall = ({ contribution }: { contribution: TreatmentContribution }) => {
  const hasActivity = contribution.total > 0;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <h2 className="text-sm font-medium text-slate-500">处置完成记录</h2>
        <span className="text-sm text-slate-500">{hasActivity ? `单日最高 ${contribution.max} 个处置` : '暂无处置记录'}</span>
      </div>
      <div className="rounded-2xl border border-slate-200 p-5">
        <div className="flex gap-3 overflow-x-auto pb-2">
          <div className="grid grid-rows-7 gap-1 pt-0.5 text-[11px] leading-3 text-slate-400 flex-shrink-0">
            {WEEKDAY_LABELS.map((label, index) => (
              <div key={label} className="h-3 flex items-center justify-end">
                {index % 2 === 1 ? label : ''}
              </div>
            ))}
          </div>

          <div className="grid grid-flow-col grid-rows-7 gap-1 min-w-max">
            {contribution.days.map(day => (
              <div
                key={day.date}
                title={`${day.date}: ${day.count} 个处置`}
                className={`h-3 w-3 rounded-sm border ${getContributionColor(day.count, day.isFuture)}`}
              />
            ))}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
          <span>每个格子代表一天，处置完成越多颜色越醒目。</span>
          <div className="flex items-center gap-2">
            <span>少</span>
            {[0, 1, 2, 3, 5].map(level => (
              <span key={level} className={`h-3 w-3 rounded-sm border ${getContributionColor(level, false)}`} />
            ))}
            <span>多</span>
          </div>
        </div>
      </div>
    </section>
  );
};
