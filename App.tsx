import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArchiveRestore, BarChart3, BellRing, Calendar, CalendarDays, Download, ExternalLink, LayoutDashboard, PanelLeftClose, PanelLeftOpen, RefreshCw, Settings, Upload, Users, X } from 'lucide-react';
import { APP_VERSION, RELEASES_URL } from './constants';
import { SidebarActionButton } from './components/SidebarActionButton';
import { SidebarItem } from './components/SidebarItem';
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
import { ImportPreview, Patient, ReleaseCheckResult } from './types';
import { loadReportChartSettings, ReportChartSettings, saveReportChartSettings } from './features/reports/reportSettings';

const AGE_REVIEW_DECISION_KEY_PREFIX = 'ageReviewDecision';
const SIDEBAR_COLLAPSED_KEY = 'dentalSidebarCollapsed';

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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
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
      return <PatientDetail patient={patient} onBack={() => setSelectedPatientId(null)} onRefresh={refreshData} />;
    }

    switch (currentView) {
      case 'dashboard':
        return <Dashboard onViewChange={setCurrentView} patients={patients} onPatientClick={handlePatientClick} onRefresh={refreshData} />;
      case 'patients':
        return <PatientList patients={patients} onSelect={handlePatientClick} onRefresh={refreshData} />;
      case 'calendar':
        return <PatientCalendar patients={patients} onPatientClick={handlePatientClick} />;
      case 'schedule':
        return <ScheduleManager patients={patients} onRefresh={refreshData} onPatientClick={handlePatientClick} />;
      case 'reports':
        return <Reports patients={patients} chartSettings={reportChartSettings} />;
      default:
        return <Dashboard onViewChange={setCurrentView} patients={patients} onPatientClick={handlePatientClick} onRefresh={refreshData} />;
    }
  };

  return (
    <div className="relative flex h-screen overflow-hidden bg-canvas font-sans text-slate-900">
      <aside className={`${sidebarCollapsed ? 'w-20' : 'w-64'} relative z-20 flex flex-shrink-0 flex-col bg-gradient-to-b from-slate-900 to-teal-950 text-slate-300 shadow-clinic transition-[width] duration-300`}>
        <div className={`${sidebarCollapsed ? 'p-3' : 'p-4'} border-b border-white/10`}>
          <div className={`flex min-w-0 items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'}`}>
            <img src="./app-icon.png" alt="" className="h-11 w-11 flex-shrink-0 rounded-xl bg-surface object-cover shadow-sm ring-1 ring-white/20" />
            {!sidebarCollapsed && <div className="min-w-0 flex-1">
              <div className="font-bold text-lg leading-tight text-white truncate">{clinicName}</div>
              <div className="mt-1 font-mono text-xs text-slate-400">v{APP_VERSION}</div>
            </div>}
          </div>
        </div>

        <button
          type="button"
          aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
          onClick={() => setSidebarCollapsed(value => !value)}
          className="absolute -right-3 top-[72px] z-30 flex h-7 w-7 items-center justify-center rounded-full border border-white/15 bg-teal-950 text-slate-300 shadow-md transition-colors hover:bg-clay-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-300"
        >
          {sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
        </button>

        <div className={`${sidebarCollapsed ? 'p-2' : 'p-4'} min-h-0 flex-1 overflow-y-auto`}>
          <nav aria-label="主导航" className="space-y-2">
            <SidebarItem
              icon={<LayoutDashboard size={20} />}
              label="总览"
              collapsed={sidebarCollapsed}
              active={currentView === 'dashboard' && !selectedPatientId}
              onClick={() => { setSelectedPatientId(null); setCurrentView('dashboard'); }}
            />
            <SidebarItem
              icon={<Users size={20} />}
              label="患者管理"
              collapsed={sidebarCollapsed}
              active={currentView === 'patients'}
              onClick={() => { setSelectedPatientId(null); setCurrentView('patients'); }}
            />
            <SidebarItem
              icon={<CalendarDays size={20} />}
              label="日历"
              collapsed={sidebarCollapsed}
              active={currentView === 'calendar'}
              onClick={() => { setSelectedPatientId(null); setCurrentView('calendar'); }}
            />
            <SidebarItem
              icon={<Calendar size={20} />}
              label="日程预约"
              collapsed={sidebarCollapsed}
              active={currentView === 'schedule'}
              onClick={() => { setSelectedPatientId(null); setCurrentView('schedule'); }}
            />
            <SidebarItem
              icon={<BarChart3 size={20} />}
              label="统计报表"
              collapsed={sidebarCollapsed}
              active={currentView === 'reports'}
              onClick={() => { setSelectedPatientId(null); setCurrentView('reports'); }}
            />
          </nav>

          <section aria-label="数据工具" className={`${sidebarCollapsed ? 'pt-3' : 'mx-1 pt-4'} mt-4 space-y-1 border-t border-white/10`}>
            {!sidebarCollapsed && (
              <div className="px-3 pb-1 text-[11px] font-bold tracking-wider text-slate-500">数据工具</div>
            )}
            <SidebarActionButton
              icon={<Download size={19} />}
              label="导出备份文件"
              collapsed={sidebarCollapsed}
              onClick={handleExportBackup}
              disabled={sidebarActionBlocked}
              disabledTitle={blockedActionTitle}
            />
            <SidebarActionButton
              icon={<Upload size={19} />}
              label="选择文件导入"
              collapsed={sidebarCollapsed}
              onClick={() => importFileInputRef.current?.click()}
              disabled={sidebarActionBlocked}
              disabledTitle={blockedActionTitle}
            />
            <SidebarActionButton
              icon={<ArchiveRestore size={19} />}
              label="恢复之前备份"
              collapsed={sidebarCollapsed}
              onClick={openRestoreConfirmation}
              disabled={!hasPreImportBackup || sidebarActionBlocked}
              disabledTitle={!hasPreImportBackup ? '暂无可恢复备份' : blockedActionTitle}
            />
            <SidebarActionButton
              icon={<RefreshCw size={19} className={isCheckingRelease ? 'animate-spin' : undefined} />}
              label={isCheckingRelease ? '正在检查更新' : '应用更新'}
              collapsed={sidebarCollapsed}
              onClick={handleApplicationUpdate}
              disabled={isCheckingRelease || sidebarActionBlocked}
              badge={Boolean(releaseStatus?.success && releaseStatus.updateAvailable)}
              disabledTitle={isCheckingRelease ? '正在检查更新' : '请先关闭当前弹窗'}
            />
          </section>
        </div>

        <div className={`${sidebarCollapsed ? 'p-2' : 'p-4'} border-t border-white/10`}>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            aria-label="系统设置"
            title={sidebarCollapsed ? '系统设置' : undefined}
            className={`flex w-full items-center rounded-xl py-3 text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clay-300 ${sidebarCollapsed ? 'justify-center px-2' : 'gap-3 px-4'}`}
          >
            <Settings size={20} className="shrink-0" />
            <span className={sidebarCollapsed ? 'sr-only' : 'font-medium'}>系统设置</span>
          </button>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-auto">
        {renderContent()}
      </main>

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
