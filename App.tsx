import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, BarChart3, BellRing, Calendar, CalendarDays, Download, ExternalLink, LayoutDashboard, Moon, PanelLeftClose, PanelLeftOpen, Plus, RefreshCw, Rotate3d, Search, Settings, Sun, Upload, Users, X } from 'lucide-react';
import { APP_VERSION, RELEASES_URL } from './constants';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SidebarActionButton } from './components/SidebarActionButton';
import { SidebarItem } from './components/SidebarItem';
import { AddAppointmentModal } from './modals/AddAppointmentModal';
import { ConfirmationModal } from './modals/ConfirmationModal';
import { ImportPreviewModal } from './modals/ImportPreviewModal';
import { SettingsModal } from './modals/SettingsModal';
import { Dashboard } from './pages/Dashboard';
import { PatientCalendar } from './pages/PatientCalendar';
import { PatientDetail } from './pages/PatientDetail';
import { PatientList } from './pages/PatientList';
import { Reports } from './pages/Reports';
import { ScheduleManager } from './pages/ScheduleManager';
import { clinicService } from './services/clinicService';
import { View } from './appTypes';
import { ImportPreview, Patient, PatientListItem, ReleaseCheckResult } from './types';
import { loadReportChartSettings, ReportChartSettings, saveReportChartSettings } from './features/reports/reportSettings';
import { formatDateKey } from './utils/date';
import { getTheme, setTheme, Theme } from './utils/theme';

const AGE_REVIEW_DECISION_KEY_PREFIX = 'ageReviewDecision';
const SIDEBAR_COLLAPSED_KEY = 'dentalSidebarCollapsed';
const RECENT_PATIENT_COUNT = 6;
// macOS 安装版隐藏了系统标题栏，红绿灯嵌在侧栏左上角，侧栏顶部要给它留位置。
const INSET_TITLEBAR = window.electronPlatform === 'darwin';
// 收起后的侧栏宽度：红绿灯左右各留 12px（和 electron-main.js 里的左边距一致），所以跟着红绿灯整组的宽度走。
const COLLAPSED_WIDTH_CLASS = !INSET_TITLEBAR ? 'w-[68px]' : (window.electronTrafficLightsWidth ?? 52) > 52 ? 'w-[84px]' : 'w-[76px]';
const IS_MAC = navigator.platform.startsWith('Mac');

// 影像融合模块体积较大（three.js 等），首次进入时才加载。
const ImagingFusion = React.lazy(() => import('./pages/ImagingFusion').then(module => ({ default: module.ImagingFusion })));

const getAgeReviewDecisionKey = (year: number) => `${AGE_REVIEW_DECISION_KEY_PREFIX}_${year}`;

const isAgeReviewDay = (date: Date) => date.getMonth() === 0 && date.getDate() === 1;

export default function App() {
  const [currentView, setCurrentView] = useState<View>('dashboard');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [clinicName, setClinicName] = useState('DentalClinic');
  const [refreshKey, setRefreshKey] = useState(0);
  const [ageReviewDecisionYear, setAgeReviewDecisionYear] = useState<number | null>(null);
  const [releaseStatus, setReleaseStatus] = useState<ReleaseCheckResult | null>(null);
  const [isUpdateNoticeDismissed, setIsUpdateNoticeDismissed] = useState(false);
  const [reportChartSettings, setReportChartSettings] = useState(loadReportChartSettings);
  const importFileInputRef = useRef<HTMLInputElement>(null);
  const [pendingImportContent, setPendingImportContent] = useState<string | null>(null);
  const [pendingImportPreview, setPendingImportPreview] = useState<ImportPreview | null>(null);
  const [isReadingImport, setIsReadingImport] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState(false);
  const [restoreError, setRestoreError] = useState<string>();
  const [hasPreImportBackup, setHasPreImportBackup] = useState(() => clinicService.hasPreImportBackup());
  const [isCheckingRelease, setIsCheckingRelease] = useState(true);
  const [actionStatus, setActionStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const settingsPatients = useMemo(() => clinicService.getAllPatients(), [refreshKey]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
  const [imagingOpened, setImagingOpened] = useState(false);
  const [recentPatients, setRecentPatients] = useState<PatientListItem[]>([]);
  const [showAppointmentModal, setShowAppointmentModal] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const showImaging = currentView === 'imaging' && !selectedPatientId;
  const today = new Date();
  const currentYear = today.getFullYear();
  const shouldShowAgeReviewNotice = isAgeReviewDay(today)
    && clinicService.getAllPatients().length > 0
    && ageReviewDecisionYear !== currentYear
    && !localStorage.getItem(getAgeReviewDecisionKey(currentYear));

  useEffect(() => {
    setClinicName(clinicService.getClinicName());
    if (currentView === 'patients') {
      setPatients([]);
      return;
    }
    setPatients(clinicService.getAllPatients());
  }, [refreshKey, currentView]);

  // 侧栏的“最近患者”沿用患者列表的排序：今日到诊在前，其余按最近改动时间。
  useEffect(() => {
    let cancelled = false;
    clinicService.getPatientListPage({ offset: 0, limit: RECENT_PATIENT_COUNT, scope: 'all' })
      .then(page => { if (!cancelled) setRecentPatients(page.items); })
      .catch(() => { if (!cancelled) setRecentPatients([]); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // macOS 只认 ⌘K，Ctrl+K 留给文本框的“删到行尾”。
      if (!(IS_MAC ? event.metaKey : event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      // 有弹窗或患者资料正在编辑时不跳走，免得丢掉没保存的内容。
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-unsaved-edit]')) return;
      event.preventDefault();
      setSelectedPatientId(null);
      setCurrentView('dashboard');
      setSearchFocusToken(value => value + 1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (selectedPatientId && !clinicService.getPatient(selectedPatientId)) {
      setSelectedPatientId(null);
    }
  }, [selectedPatientId, refreshKey]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    let active = true;
    void clinicService.checkLatestReleaseOnce()
      .then(result => {
        if (active) setReleaseStatus(result);
      })
      .finally(() => {
        if (active) setIsCheckingRelease(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!actionStatus) return;
    const timeoutId = window.setTimeout(() => setActionStatus(null), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [actionStatus]);

  const refreshData = () => {
    setRefreshKey(prev => prev + 1);
  };

  const updateReportChartSettings = (settings: ReportChartSettings) => {
    setReportChartSettings(saveReportChartSettings(settings));
  };

  const dataActionBusy = isReadingImport || isImporting || isRestoringBackup;
  const sidebarModalOpen = showSettings || Boolean(pendingImportPreview) || showRestoreConfirm;
  const sidebarActionBlocked = dataActionBusy || sidebarModalOpen;
  const blockedActionTitle = dataActionBusy ? '数据操作进行中' : '请先关闭当前弹窗';

  const handleExportBackup = () => {
    try {
      const blob = new Blob([clinicService.exportData()], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dental_clinic_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setActionStatus({ type: 'success', message: '备份文件已导出。' });
    } catch {
      setActionStatus({ type: 'error', message: '导出失败，请稍后重试。' });
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    setIsReadingImport(true);
    setActionStatus(null);
    try {
      const content = await file.text();
      const result = clinicService.createImportPreview(content);
      if (!result.success || !result.preview) {
        setPendingImportContent(null);
        setPendingImportPreview(null);
        setActionStatus({ type: 'error', message: result.message });
        return;
      }
      setPendingImportContent(content);
      setPendingImportPreview(result.preview);
    } catch {
      setPendingImportContent(null);
      setPendingImportPreview(null);
      setActionStatus({ type: 'error', message: '读取备份文件失败，请重新选择文件。' });
    } finally {
      setIsReadingImport(false);
    }
  };

  const cancelImportPreview = () => {
    if (isImporting) return;
    setPendingImportContent(null);
    setPendingImportPreview(null);
  };

  const confirmImport = async () => {
    if (!pendingImportContent || isImporting) return;
    setIsImporting(true);
    const result = await clinicService.importData(pendingImportContent);
    setIsImporting(false);
    setPendingImportContent(null);
    setPendingImportPreview(null);
    setActionStatus({ type: result.success ? 'success' : 'error', message: result.message });
    if (result.success) {
      setHasPreImportBackup(clinicService.hasPreImportBackup());
      refreshData();
    }
  };

  const openRestoreConfirmation = () => {
    setRestoreError(undefined);
    setShowRestoreConfirm(true);
  };

  const confirmRestorePreImportBackup = async () => {
    if (isRestoringBackup) return;
    setIsRestoringBackup(true);
    setRestoreError(undefined);
    const result = await clinicService.restorePreImportBackup();
    setIsRestoringBackup(false);
    if (!result.success) {
      setRestoreError(result.message);
      return;
    }
    setShowRestoreConfirm(false);
    setActionStatus({ type: 'success', message: result.message });
    refreshData();
  };

  const handleApplicationUpdate = async () => {
    if (isCheckingRelease) return;
    if (releaseStatus?.success && releaseStatus.updateAvailable) {
      window.open(releaseStatus.releaseUrl || RELEASES_URL, '_blank', 'noopener,noreferrer');
      return;
    }

    setIsCheckingRelease(true);
    setActionStatus(null);
    const result = await clinicService.checkLatestRelease();
    setReleaseStatus(result);
    setIsCheckingRelease(false);
    setIsUpdateNoticeDismissed(false);
    setActionStatus({
      type: result.success ? (result.updateAvailable ? 'info' : 'success') : 'error',
      message: result.message
    });
  };

  const handlePatientClick = (patientId: string) => {
    setSelectedPatientId(patientId);
    setCurrentView('patients');
  };

  const recordAgeReviewDecision = (decision: 'update' | 'skip') => {
    localStorage.setItem(getAgeReviewDecisionKey(currentYear), JSON.stringify({
      decision,
      decidedAt: new Date().toISOString()
    }));
    setAgeReviewDecisionYear(currentYear);
  };

  const handleAgeReviewUpdate = () => {
    recordAgeReviewDecision('update');
    setSelectedPatientId(null);
    setCurrentView('patients');
  };

  // 顶层只负责页面路由和全局刷新，业务表单拆到 pages/modals 中维护。
  const renderContent = () => {
    if (selectedPatientId) {
      const patient = clinicService.getPatient(selectedPatientId);
      if (!patient) {
        return <div>Patient not found</div>;
      }
      // 按患者 id 重新挂载：从侧栏直接换人时，编辑表单等内部状态不能留着上一位的内容。
      return (
        <React.Fragment key={patient.id}>
          <PatientDetail patient={patient} onBack={() => setSelectedPatientId(null)} onRefresh={refreshData} />
        </React.Fragment>
      );
    }

    switch (currentView) {
      case 'dashboard':
        return <Dashboard onViewChange={setCurrentView} patients={patients} onPatientClick={handlePatientClick} onRefresh={refreshData} clinicName={clinicName} searchFocusToken={searchFocusToken} />;
      case 'patients':
        return <PatientList patients={patients} onSelect={handlePatientClick} onRefresh={refreshData} />;
      case 'calendar':
        return <PatientCalendar patients={patients} onPatientClick={handlePatientClick} />;
      case 'schedule':
        return <ScheduleManager patients={patients} onRefresh={refreshData} onPatientClick={handlePatientClick} />;
      case 'reports':
        return <Reports patients={patients} chartSettings={reportChartSettings} />;
      case 'imaging':
        return null;
      default:
        return <Dashboard onViewChange={setCurrentView} patients={patients} onPatientClick={handlePatientClick} onRefresh={refreshData} clinicName={clinicName} searchFocusToken={searchFocusToken} />;
    }
  };

  const navigate = (view: View) => {
    setSelectedPatientId(null);
    if (view === 'imaging') setImagingOpened(true);
    setCurrentView(view);
  };

  const focusPatientSearch = () => {
    navigate('dashboard');
    setSearchFocusToken(value => value + 1);
  };

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setThemeState(next);
  };

  const ThemeIcon = theme === 'dark' ? Moon : Sun;
  const themeLabel = theme === 'dark' ? '当前为深色，点击切换到浅色' : '当前为浅色，点击切换到深色';
  const iconButtonClass = 'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-slate-600 transition-colors hover:bg-slate-200 hover:text-slate-900';

  const sidebarToggle = (
    <button
      type="button"
      aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
      title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
      onClick={() => setSidebarCollapsed(value => !value)}
      className={`app-no-drag ${iconButtonClass}`}
    >
      {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
  );

  return (
    <div className="relative flex h-screen overflow-hidden bg-white font-sans text-slate-900">
      <aside className={`${sidebarCollapsed ? COLLAPSED_WIDTH_CLASS : 'w-64'} flex flex-shrink-0 flex-col border-r border-slate-200 bg-slate-100 transition-[width] duration-200`}>
        {INSET_TITLEBAR && (
          <div className="app-drag flex h-11 flex-shrink-0 items-center justify-end pr-2">
            {!sidebarCollapsed && sidebarToggle}
          </div>
        )}
        <div className={`flex flex-shrink-0 items-center ${INSET_TITLEBAR ? 'h-14' : 'h-16'} ${sidebarCollapsed ? 'justify-center' : 'gap-3 pl-4 pr-2'}`}>
          {!sidebarCollapsed && (
            <>
              <img src="./app-icon.png" alt="" className="tone-light h-9 w-9 flex-shrink-0 rounded-xl bg-white object-cover" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium leading-tight text-slate-900">{clinicName}</div>
                <div className="mt-0.5 font-mono text-[11px] text-slate-500">v{APP_VERSION}</div>
              </div>
            </>
          )}
          {(!INSET_TITLEBAR || sidebarCollapsed) && sidebarToggle}
        </div>

        <div className={`px-3 pb-2 ${sidebarCollapsed ? 'flex justify-center' : ''}`}>
          <button
            type="button"
            aria-label="新建预约"
            title={sidebarCollapsed ? '新建预约' : undefined}
            onClick={() => setShowAppointmentModal(true)}
            className={`flex h-11 items-center rounded-2xl bg-white text-sm font-medium text-slate-800 shadow-sm ring-1 ring-slate-200 transition-shadow hover:shadow-md ${sidebarCollapsed ? 'w-11 justify-center' : 'w-full gap-3 px-4'}`}
          >
            <Plus size={18} className="shrink-0 text-teal-600" />
            <span className={sidebarCollapsed ? 'sr-only' : ''}>新建预约</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
          <nav aria-label="主导航" className="space-y-0.5">
            <SidebarItem icon={<Search size={18} />} label="搜索患者" collapsed={sidebarCollapsed} active={false} onClick={focusPatientSearch} />
            <SidebarItem icon={<LayoutDashboard size={18} />} label="总览" collapsed={sidebarCollapsed} active={currentView === 'dashboard' && !selectedPatientId} onClick={() => navigate('dashboard')} />
            <SidebarItem icon={<Users size={18} />} label="患者管理" collapsed={sidebarCollapsed} active={currentView === 'patients'} onClick={() => navigate('patients')} />
            <SidebarItem icon={<CalendarDays size={18} />} label="日历" collapsed={sidebarCollapsed} active={currentView === 'calendar' && !selectedPatientId} onClick={() => navigate('calendar')} />
            <SidebarItem icon={<Calendar size={18} />} label="日程预约" collapsed={sidebarCollapsed} active={currentView === 'schedule' && !selectedPatientId} onClick={() => navigate('schedule')} />
            <SidebarItem icon={<BarChart3 size={18} />} label="统计报表" collapsed={sidebarCollapsed} active={currentView === 'reports' && !selectedPatientId} onClick={() => navigate('reports')} />
            <SidebarItem icon={<Rotate3d size={18} />} label="影像融合" collapsed={sidebarCollapsed} active={showImaging} onClick={() => navigate('imaging')} />
          </nav>

          <section aria-label="数据工具" className="mt-4 space-y-0.5">
            {!sidebarCollapsed && <div className="px-4 pb-1.5 text-xs text-slate-500">数据工具</div>}
            <SidebarActionButton
              icon={<Download size={18} />}
              label="导出备份文件"
              collapsed={sidebarCollapsed}
              onClick={handleExportBackup}
              disabled={sidebarActionBlocked}
              disabledTitle={blockedActionTitle}
            />
            <SidebarActionButton
              icon={<Upload size={18} />}
              label="选择文件导入"
              collapsed={sidebarCollapsed}
              onClick={() => importFileInputRef.current?.click()}
              disabled={sidebarActionBlocked}
              disabledTitle={blockedActionTitle}
            />
            <SidebarActionButton
              icon={<ArchiveRestore size={18} />}
              label="恢复之前备份"
              collapsed={sidebarCollapsed}
              onClick={openRestoreConfirmation}
              disabled={!hasPreImportBackup || sidebarActionBlocked}
              disabledTitle={!hasPreImportBackup ? '暂无可恢复备份' : blockedActionTitle}
            />
            <SidebarActionButton
              icon={<RefreshCw size={18} className={isCheckingRelease ? 'animate-spin' : undefined} />}
              label={isCheckingRelease ? '正在检查更新' : '应用更新'}
              collapsed={sidebarCollapsed}
              onClick={handleApplicationUpdate}
              disabled={isCheckingRelease || sidebarActionBlocked}
              badge={Boolean(releaseStatus?.success && releaseStatus.updateAvailable)}
              disabledTitle={isCheckingRelease ? '正在检查更新' : '请先关闭当前弹窗'}
            />
          </section>

          {!sidebarCollapsed && recentPatients.length > 0 && (
            <section aria-label="最近患者" className="mt-4">
              <div className="px-4 pb-1.5 text-xs text-slate-500">最近患者</div>
              {recentPatients.map(patient => (
                <button
                  key={patient.id}
                  type="button"
                  onClick={() => handlePatientClick(patient.id)}
                  className={`flex h-9 w-full items-center gap-2 rounded-full px-4 text-left text-sm transition-colors ${
                    selectedPatientId === patient.id ? 'bg-teal-100 font-medium text-teal-900' : 'text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{patient.name}</span>
                  {patient.isTodayVisit && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-600" title="今日到诊" />}
                </button>
              ))}
            </section>
          )}
        </div>

        <div className={`flex flex-shrink-0 border-t border-slate-200 p-3 ${sidebarCollapsed ? 'flex-col items-center gap-1' : 'items-center gap-1'}`}>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label="系统设置"
            title={sidebarCollapsed ? '系统设置' : undefined}
            className={sidebarCollapsed ? iconButtonClass : 'flex h-10 min-w-0 flex-1 items-center gap-3 rounded-full px-4 text-sm text-slate-700 transition-colors hover:bg-slate-200'}
          >
            <Settings size={18} className="shrink-0" />
            <span className={sidebarCollapsed ? 'sr-only' : 'truncate'}>系统设置</span>
          </button>
          <button type="button" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel} className={iconButtonClass}>
            <ThemeIcon size={18} />
          </button>
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1">
        {/* 没有系统标题栏时，主区域顶部留一条可以拖动窗口的边。 */}
        {INSET_TITLEBAR && <div className="app-drag absolute inset-x-0 top-0 z-30 h-4" />}

        <main className={showImaging ? 'hidden' : 'flex min-w-0 flex-1 flex-col overflow-auto bg-white'}>
          {renderContent()}
        </main>

        {/* 影像工作台打开后保持挂载，切到其他页面再回来时已载入的 CBCT 和配准结果还在。 */}
        {imagingOpened && (
          <div className={showImaging ? 'flex min-w-0 flex-1 flex-col' : 'hidden'}>
            <ErrorBoundary title="影像模块无法启动" hint="本机可能不支持三维显示（WebGL）。其他功能不受影响。">
              <Suspense fallback={<div className="flex flex-1 items-center justify-center text-slate-500">正在加载影像模块...</div>}>
                <ImagingFusion />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </div>

      <input
        ref={importFileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />

      {actionStatus && (
        <div
          role="status"
          className={`fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border px-4 py-3 shadow-xl ${
            actionStatus.type === 'success'
              ? 'border-teal-200 bg-teal-50 text-teal-800'
              : actionStatus.type === 'info'
                ? 'border-amber-200 bg-amber-50 text-amber-800'
                : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <span className="text-sm font-medium">{actionStatus.message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setActionStatus(null)}
            className="rounded-md p-1 transition-colors hover:bg-black/5"
          >
            <X size={16} />
          </button>
        </div>
      )}

      {shouldShowAgeReviewNotice && (
        <div className="fixed bottom-6 right-6 z-40 w-[420px] rounded-xl border border-amber-200 bg-white p-5 shadow-2xl">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
              <BellRing size={21} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-slate-900">患者年龄年度更新提醒</div>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                今天是 {currentYear} 年 1 月 1 日。请确认是否需要更新患者年龄；做出选择前，此提醒会持续显示。
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => recordAgeReviewDecision('skip')}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                >
                  今年无需更新
                </button>
                <button
                  type="button"
                  onClick={handleAgeReviewUpdate}
                  className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-700"
                >
                  去患者库更新
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showAppointmentModal && (
        <AddAppointmentModal
          patients={settingsPatients}
          defaultDate={formatDateKey(new Date())}
          onClose={() => setShowAppointmentModal(false)}
          onSuccess={() => { setShowAppointmentModal(false); refreshData(); }}
        />
      )}

      {releaseStatus?.success && releaseStatus.updateAvailable && !isUpdateNoticeDismissed && (
        <div className="fixed right-6 top-6 z-40 w-[390px] rounded-xl border border-teal-200 bg-white p-5 shadow-2xl">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <BellRing size={21} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-bold text-slate-900">发现新版本 v{releaseStatus.latestVersion}</div>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                当前版本为 v{releaseStatus.currentVersion}，可以前往 GitHub Releases 下载更新。
              </p>
              <a
                href={releaseStatus.releaseUrl || RELEASES_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1 font-bold text-teal-700 underline underline-offset-2"
              >
                打开 Release <ExternalLink size={15} />
              </a>
            </div>
            <button
              type="button"
              aria-label="关闭更新提示"
              onClick={() => setIsUpdateNoticeDismissed(true)}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onRefresh={refreshData}
          currentClinicName={clinicName}
          patients={settingsPatients}
          reportChartSettings={reportChartSettings}
          onReportChartSettingsChange={updateReportChartSettings}
        />
      )}

      {pendingImportContent && pendingImportPreview && (
        <ImportPreviewModal
          preview={pendingImportPreview}
          isImporting={isImporting}
          onConfirm={confirmImport}
          onCancel={cancelImportPreview}
        />
      )}

      {showRestoreConfirm && (
        <ConfirmationModal
          title="恢复导入前备份确认"
          message="恢复导入前备份会覆盖当前本机数据。建议先导出当前数据后再继续。"
          confirmLabel="确认恢复备份"
          confirmingLabel="正在恢复…"
          onConfirm={confirmRestorePreImportBackup}
          onCancel={() => {
            if (!isRestoringBackup) setShowRestoreConfirm(false);
          }}
          isConfirming={isRestoringBackup}
          errorMessage={restoreError}
        />
      )}
    </div>
  );
}
