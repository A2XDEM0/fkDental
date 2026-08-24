import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, CircleDollarSign, Edit2, Plus, Save, Settings, Trash2, Upload, X } from 'lucide-react';
import { clinicService } from '../services/clinicService';
import { Patient, TreatmentCategory, TreatmentItem } from '../types';
import { Button } from '../components/Button';
import { ModalBase } from './ModalBase';
import { buildReportStats } from '../features/reports/reportStats';
import { REPORT_AXIS_SCALE_LABELS, ReportAxisScale, ReportChartSettings } from '../features/reports/reportSettings';

const normalizeCloudServiceUrl = (value: string) => value.trim().replace(/\/(backup|sync)\/?$/i, '').replace(/\/+$/, '');

const createCloudEndpoint = (serviceUrl: string, path: 'backup' | 'sync') => (
  `${normalizeCloudServiceUrl(serviceUrl)}/${path}`
);

const currencyFormatter = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2
});

const formatCurrency = (value: number) => currencyFormatter.format(value);

const ScalePicker = ({
  title,
  value,
  onChange
}: {
  title: string;
  value: ReportAxisScale;
  onChange: (value: ReportAxisScale) => void;
}) => {
  const options: ReportAxisScale[] = ['linear', 'log', 'power'];

  return (
    <fieldset>
      <legend className="mb-3 text-base font-bold text-slate-800">{title}</legend>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {options.map(option => (
          <label
            key={option}
            className={`cursor-pointer rounded-xl border p-4 transition-colors ${
              value === option
                ? 'border-teal-500 bg-teal-50 ring-1 ring-teal-500'
                : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
          >
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name={title}
                value={option}
                checked={value === option}
                onChange={() => onChange(option)}
                className="h-4 w-4 border-slate-300 text-teal-600 focus:ring-teal-500"
              />
              <span className="font-bold text-slate-800">{REPORT_AXIS_SCALE_LABELS[option]}</span>
            </div>
          </label>
        ))}
      </div>
    </fieldset>
  );
};

export const SettingsModal = ({
  onClose,
  onRefresh,
  currentClinicName,
  patients,
  reportChartSettings,
  onReportChartSettingsChange
}: {
  onClose: () => void;
  onRefresh: () => void;
  currentClinicName: string;
  patients: Patient[];
  reportChartSettings: ReportChartSettings;
  onReportChartSettingsChange: (settings: ReportChartSettings) => void;
}) => {
  const [tab, setTab] = useState<'data' | 'reports' | 'catalog'>('data');
  const isMountedRef = useRef(true);
  const [clinicNameForm, setClinicNameForm] = useState(currentClinicName);
  const [cloudServiceSettings, setCloudServiceSettings] = useState(() => {
    const backup = clinicService.getBackupSettings();
    const sync = clinicService.getCloudSyncSettings();
    return {
      serviceUrl: normalizeCloudServiceUrl(backup.endpoint || sync.endpoint),
      key: backup.token || sync.key
    };
  });
  const [cloudStatus, setCloudStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const [isPullingCloud, setIsPullingCloud] = useState(false);
  const [isPushingCloud, setIsPushingCloud] = useState(false);
  const reportStats = useMemo(() => buildReportStats(patients), [patients]);

  // 处置目录直接影响新增处置时的默认价格。
  const [catalog, setCatalog] = useState<TreatmentCategory[]>(clinicService.getCatalog());
  const [newCatName, setNewCatName] = useState('');

  // 新增项目的临时表单状态。
  const [addingItemTo, setAddingItemTo] = useState<string | null>(null);
  const [newItemForm, setNewItemForm] = useState({ name: '', price: 0 });

  // 编辑项目时只保存当前项目的局部状态。
  const [editingItem, setEditingItem] = useState<{catId: string, itemId: string} | null>(null);
  const [editItemForm, setEditItemForm] = useState({ name: '', price: 0 });

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const handleSaveClinicName = () => {
    clinicService.updateClinicName(clinicNameForm.trim());
    alert('诊所名称已更新');
    onRefresh();
  };

  const saveCloudServiceSettings = () => {
    const serviceUrl = normalizeCloudServiceUrl(cloudServiceSettings.serviceUrl);
    const key = cloudServiceSettings.key.trim();
    if (!serviceUrl || !key) return null;
    const backupSettings = { endpoint: createCloudEndpoint(serviceUrl, 'backup'), token: key };
    const syncSettings = { endpoint: createCloudEndpoint(serviceUrl, 'sync'), key };
    clinicService.updateBackupSettings(backupSettings);
    clinicService.updateCloudSyncSettings(syncSettings);
    setCloudServiceSettings({ serviceUrl, key });
    return { backupSettings, syncSettings };
  };

  const handlePullCloudData = async () => {
    if (!confirm('从云端同步会覆盖本机数据，确定继续吗？')) return;
    setIsPullingCloud(true);
    setCloudStatus(null);
    const settings = saveCloudServiceSettings();
    if (!settings) {
      setCloudStatus({ type: 'error', message: '请填写云端服务地址和访问密钥。' });
      setIsPullingCloud(false);
      return;
    }
    const { syncSettings } = settings;
    const result = await clinicService.pullCloudData(syncSettings);
    if (!isMountedRef.current) return;
    setCloudStatus({ type: result.success ? 'success' : 'error', message: result.message });
    if (result.success) onRefresh();
    setIsPullingCloud(false);
  };

  const handleUploadBackup = async () => {
    setIsPushingCloud(true);
    setCloudStatus(null);
    const settings = saveCloudServiceSettings();
    if (!settings) {
      setCloudStatus({ type: 'error', message: '请填写云端服务地址和访问密钥。' });
      setIsPushingCloud(false);
      return;
    }
    const { syncSettings } = settings;
    const result = await clinicService.pushCloudData(syncSettings);
    if (!isMountedRef.current) return;
    setCloudStatus({ type: result.success ? 'success' : 'error', message: result.message });
    setIsPushingCloud(false);
  };

  // 目录维护逻辑：先在弹窗本地编辑，点击保存后统一写入本地数据。
  const addCategory = () => {
    const clean = newCatName.trim();
    if (!clean) return;
    const newCat: TreatmentCategory = {
      id: `cat_${Date.now()}`,
      name: clean,
      items: []
    };
    const updated = [...catalog, newCat];
    setCatalog(updated);
    setNewCatName('');
  };

  const deleteCategory = (catId: string) => {
    if(!confirm("确定删除该分类及其所有项目吗？")) return;
    setCatalog(catalog.filter(c => c.id !== catId));
  };

  // 项目新增与编辑都保留在设置弹窗内，避免污染全局状态。
  const startAddItem = (catId: string) => {
    setAddingItemTo(catId);
    setNewItemForm({ name: '', price: 0 });
  };

  const confirmAddItem = (catId: string) => {
    const cleanName = newItemForm.name.trim();
    if (!cleanName) return;

    setCatalog(catalog.map(c => {
      if (c.id === catId) {
        return {
          ...c,
          items: [...c.items, { id: Date.now().toString(), name: cleanName, price: newItemForm.price }]
        };
      }
      return c;
    }));
    setAddingItemTo(null);
    setNewItemForm({ name: '', price: 0 });
  };

  const deleteItem = (catId: string, itemId: string) => {
    setCatalog(catalog.map(c => {
      if (c.id === catId) {
        return { ...c, items: c.items.filter(i => i.id !== itemId) };
      }
      return c;
    }));
  };

  const startEditItem = (item: TreatmentItem, catId: string) => {
    setEditingItem({ catId, itemId: item.id });
    setEditItemForm({ name: item.name, price: item.price });
  };

  const saveEditItem = () => {
    if (!editingItem) return;
    const cleanName = editItemForm.name.trim();
    if (!cleanName) return;
    setCatalog(catalog.map(c => {
      if (c.id === editingItem.catId) {
        return {
          ...c,
          items: c.items.map(i => i.id === editingItem.itemId ? { ...i, name: cleanName, price: editItemForm.price } : i)
        };
      }
      return c;
    }));
    setEditingItem(null);
  };

  const saveCatalog = () => {
    clinicService.updateCatalog(catalog);
    alert("目录已更新");
    onRefresh();
  };

  return (
    <ModalBase title="系统设置" onClose={onClose} size="2xl">
      <div className="mb-8 flex flex-wrap gap-x-6 gap-y-3 border-b border-slate-200">
        <button onClick={() => setTab('data')} className={`pb-3 px-2 text-lg font-medium transition-colors ${tab === 'data' ? 'border-b-2 border-teal-600 text-teal-800' : 'text-slate-500 hover:text-slate-700'}`}>通用与数据</button>
        <button onClick={() => setTab('reports')} className={`pb-3 px-2 text-lg font-medium transition-colors ${tab === 'reports' ? 'border-b-2 border-teal-600 text-teal-800' : 'text-slate-500 hover:text-slate-700'}`}>统计与收入</button>
        <button onClick={() => setTab('catalog')} className={`pb-3 px-2 text-lg font-medium transition-colors ${tab === 'catalog' ? 'border-b-2 border-teal-600 text-teal-800' : 'text-slate-500 hover:text-slate-700'}`}>处置项目管理</button>
      </div>

      {tab === 'data' && (
        <div className="space-y-8">
          <div className="bg-slate-50 p-8 rounded-xl border border-slate-200">
            <h4 className="font-bold text-slate-800 mb-2 flex items-center gap-2 text-lg">
              <Upload size={24} className="text-teal-600" /> 云端数据
            </h4>
            <div className="space-y-4">
              <div>
                <label className="block text-slate-600 mb-2 font-medium">云端服务地址</label>
                <input
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 text-lg outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="https://your-worker.workers.dev"
                  value={cloudServiceSettings.serviceUrl}
                  onChange={e => {
                    setCloudServiceSettings({ ...cloudServiceSettings, serviceUrl: e.target.value });
                    setCloudStatus(null);
                  }}
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-2 font-medium">访问密钥</label>
                <input
                  type="password"
                  className="w-full border border-slate-300 rounded-lg px-4 py-3 text-lg outline-none focus:ring-2 focus:ring-teal-500"
                  placeholder="服务器 BACKUP_TOKEN"
                  value={cloudServiceSettings.key}
                  onChange={e => {
                    setCloudServiceSettings({ ...cloudServiceSettings, key: e.target.value });
                    setCloudStatus(null);
                  }}
                />
              </div>
              {cloudStatus && (
                <div className={`rounded-lg border px-4 py-3 text-base ${
                  cloudStatus.type === 'success'
                    ? 'border-teal-200 bg-teal-50 text-teal-800'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}>
                  {cloudStatus.message}
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                <Button onClick={handleUploadBackup} size="lg" disabled={isPullingCloud || isPushingCloud}>
                  {isPushingCloud ? '上传中...' : '上传备份'}
                </Button>
                <Button onClick={handlePullCloudData} variant="secondary" size="lg" disabled={isPullingCloud || isPushingCloud}>
                  {isPullingCloud ? '同步中...' : '云端同步'}
                </Button>
              </div>
            </div>
          </div>

          <div className="bg-slate-50 p-8 rounded-xl border border-slate-200">
            <h4 className="font-bold text-slate-800 mb-4 flex items-center gap-2 text-lg">
              <Settings size={24} className="text-teal-600" /> 诊所名称
            </h4>
            <div className="flex gap-4 items-end">
              <div className="flex-1">
                 <input className="w-full border border-slate-300 rounded-lg px-4 py-3 text-lg outline-none focus:ring-2 focus:ring-teal-500" value={clinicNameForm} onChange={e => setClinicNameForm(e.target.value)} />
              </div>
              <Button onClick={handleSaveClinicName} size="lg">保存名称</Button>
            </div>
          </div>
        </div>
      )}

      {tab === 'reports' && (
        <div className="space-y-8">
          <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-7">
            <div className="mb-6 flex items-start gap-3">
              <div className="rounded-lg bg-teal-100 p-2 text-teal-700">
                <BarChart3 size={22} />
              </div>
              <div>
                <h4 className="text-lg font-bold text-slate-900">折线图坐标关系</h4>
              </div>
            </div>

            <div className="space-y-7">
              <ScalePicker
                title="横轴（日期）"
                value={reportChartSettings.xScale}
                onChange={xScale => onReportChartSettingsChange({ ...reportChartSettings, xScale })}
              />
              <ScalePicker
                title="纵轴（金额 / 客流）"
                value={reportChartSettings.yScale}
                onChange={yScale => onReportChartSettingsChange({ ...reportChartSettings, yScale })}
              />

              {(reportChartSettings.xScale === 'power' || reportChartSettings.yScale === 'power') && (
                <div className="max-w-sm rounded-xl border border-clay-200 bg-clay-50 p-4">
                  <label className="block font-bold text-clay-900" htmlFor="report-power-exponent">幂函数指数</label>
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      id="report-power-exponent"
                      type="range"
                      min="0.1"
                      max="5"
                      step="0.1"
                      value={reportChartSettings.powerExponent}
                      onChange={event => {
                        const powerExponent = Number(event.target.value);
                        if (Number.isFinite(powerExponent)) {
                          onReportChartSettingsChange({ ...reportChartSettings, powerExponent });
                        }
                      }}
                      className="h-2 flex-1 cursor-pointer accent-clay-600"
                    />
                    <output className="min-w-14 rounded-lg bg-white px-3 py-2 text-center text-lg font-bold text-clay-900 shadow-sm">
                      {reportChartSettings.powerExponent.toFixed(1)}
                    </output>
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-col gap-4 border-b border-slate-100 bg-slate-50 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-clay-100 p-2 text-clay-700">
                  <CircleDollarSign size={22} />
                </div>
                <div>
                  <h4 className="text-lg font-bold text-slate-900">总收入明细</h4>
                </div>
              </div>
              <div className="text-left sm:text-right">
                <div className="text-sm font-medium text-slate-500">{reportStats.revenueDetails.length} 条处置收费</div>
                <div className="mt-1 text-2xl font-bold text-clay-700">{formatCurrency(reportStats.totalRevenue)}</div>
              </div>
            </div>

            {reportStats.revenueDetails.length === 0 ? (
              <div className="px-6 py-14 text-center text-slate-400">暂无收入明细</div>
            ) : (
              <div className="max-h-[52vh] overflow-auto">
                <table className="w-full min-w-[760px] text-left">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-sm font-bold text-slate-500 shadow-sm">
                    <tr>
                      <th className="px-5 py-3">日期</th>
                      <th className="px-5 py-3">患者</th>
                      <th className="px-5 py-3">电话</th>
                      <th className="px-5 py-3">处置项目</th>
                      <th className="px-5 py-3 text-right">金额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {reportStats.revenueDetails.map(detail => (
                      <tr key={detail.key} className="hover:bg-clay-50/40">
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-slate-600">
                          <div className="flex items-center gap-2">
                            <span>{detail.date || '未填写'}</span>
                            {!detail.includedInChart && (
                              <span className="rounded-full bg-amber-100 px-2 py-0.5 font-sans text-xs font-bold text-amber-700">未纳入折线</span>
                            )}
                          </div>
                        </td>
                        <td className="px-5 py-4 font-bold text-slate-900">{detail.patientName}</td>
                        <td className="whitespace-nowrap px-5 py-4 font-mono text-slate-500">{detail.phone || '未填写'}</td>
                        <td className="px-5 py-4 text-slate-700">{detail.item}</td>
                        <td className="whitespace-nowrap px-5 py-4 text-right font-mono font-bold text-clay-700">{formatCurrency(detail.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'catalog' && (
        <div className="space-y-6">
          <div className="flex gap-4 mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200">
             <input className="border border-slate-300 px-4 py-2 rounded-lg flex-1 text-base outline-none focus:ring-2 focus:ring-teal-500" placeholder="输入新分类名称..." value={newCatName} onChange={e => setNewCatName(e.target.value)} />
             <Button onClick={addCategory}>添加分类</Button>
          </div>
          <div className="flex justify-end mb-2">
             <Button onClick={saveCatalog} variant="primary" size="lg" className="shadow-md"><Save size={18} className="mr-2"/> 保存所有更改</Button>
          </div>
          <div className="max-h-[60vh] overflow-y-auto space-y-6 pr-2">
            {catalog.map(cat => (
              <div key={cat.id} className="border border-slate-200 rounded-xl p-5 shadow-sm">
                 <div className="flex justify-between items-center mb-4 bg-slate-50 p-3 rounded-lg border border-slate-100">
                    <h5 className="font-bold text-lg text-slate-800">{cat.name}</h5>
                    <div className="flex gap-3">
                       <button onClick={() => startAddItem(cat.id)} className="text-sm bg-teal-100 hover:bg-teal-200 text-teal-800 px-3 py-1.5 rounded-md font-medium transition-colors flex items-center gap-1"><Plus size={14}/> 添加项目</button>
                       <button onClick={() => deleteCategory(cat.id)} className="text-slate-400 hover:text-red-500 p-1.5 rounded hover:bg-red-50 transition-colors"><Trash2 size={18}/></button>
                    </div>
                 </div>

                 {addingItemTo === cat.id && (
                    <div className="mb-4 flex items-center gap-3 p-3 bg-teal-50 border border-teal-200 rounded-lg animate-in fade-in slide-in-from-top-2">
                      <input
                        className="flex-1 border border-teal-300 rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500"
                        placeholder="项目名称"
                        value={newItemForm.name}
                        onChange={e => setNewItemForm({...newItemForm, name: e.target.value})}
                        autoFocus
                      />
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500 text-sm">¥</span>
                        <input
                          className="w-24 border border-teal-300 rounded px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-teal-500"
                          type="number"
                          placeholder="0"
                          value={newItemForm.price}
                          onChange={e => setNewItemForm({...newItemForm, price: parseFloat(e.target.value)})}
                        />
                      </div>
                      <Button size="sm" onClick={() => confirmAddItem(cat.id)}>确定</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAddingItemTo(null)}>取消</Button>
                    </div>
                 )}

                 <div className="space-y-2 pl-2">
                   {cat.items.length === 0 && <p className="text-slate-400 text-sm italic py-2">暂无项目</p>}
                   {cat.items.map(item => (
                     <div key={item.id} className="flex justify-between text-base border-b border-dashed border-slate-100 py-3 items-center hover:bg-slate-50 px-2 rounded transition-colors">
                        {editingItem?.itemId === item.id ? (
                          <div className="flex gap-3 flex-1 items-center bg-white p-1 rounded shadow-sm border border-blue-200">
                             <input className="border border-slate-300 rounded px-3 py-1.5 flex-1 text-base outline-none focus:ring-1 focus:ring-blue-500" value={editItemForm.name} onChange={e => setEditItemForm({...editItemForm, name: e.target.value})} />
                             <input className="border border-slate-300 rounded px-3 py-1.5 w-24 text-base outline-none focus:ring-1 focus:ring-blue-500" type="number" value={editItemForm.price} onChange={e => setEditItemForm({...editItemForm, price: parseFloat(e.target.value)})} />
                             <button onClick={saveEditItem} className="text-green-600 hover:text-green-800 p-1 hover:bg-green-50 rounded"><Check size={20} /></button>
                             <button onClick={() => setEditingItem(null)} className="text-slate-400 hover:text-slate-600 p-1 hover:bg-slate-100 rounded"><X size={20} /></button>
                          </div>
                        ) : (
                          <>
                            <span className="text-slate-700 font-medium">{item.name}</span>
                            <div className="flex gap-6 items-center">
                              <span className="font-mono text-slate-500 font-bold">¥{item.price}</span>
                              <div className="flex gap-1">
                                <button onClick={() => startEditItem(item, cat.id)} className="text-slate-300 hover:text-blue-500 p-1.5 rounded hover:bg-blue-50 transition-colors"><Edit2 size={16}/></button>
                                <button onClick={() => deleteItem(cat.id, item.id)} className="text-slate-300 hover:text-red-500 p-1.5 rounded hover:bg-red-50 transition-colors"><X size={16}/></button>
                              </div>
                            </div>
                          </>
                        )}
                     </div>
                   ))}
                 </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </ModalBase>
  );
};
