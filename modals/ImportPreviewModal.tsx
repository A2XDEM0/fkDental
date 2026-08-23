import React from 'react';
import { ImportPreview } from '../types';
import { Button } from '../components/Button';
import { ModalBase } from './ModalBase';

export const ImportPreviewModal = ({
  preview,
  isImporting,
  onConfirm,
  onCancel
}: {
  preview: ImportPreview;
  isImporting: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) => (
  <ModalBase title="导入预览" onClose={onCancel} size="lg" closeDisabled={isImporting}>
    <div className="space-y-6">
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 text-amber-900">
        <div className="text-lg font-bold">确认后将覆盖当前本机数据</div>
        <div className="mt-1 text-sm leading-6">
          系统会在写入前保存导入前备份。
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-sm text-slate-500">当前诊所</div>
          <div className="mt-1 font-bold text-slate-800">{preview.currentClinicName}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-sm text-slate-500">导入后诊所</div>
          <div className="mt-1 font-bold text-slate-800">{preview.incomingClinicName}</div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[620px] text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3">数据项</th>
              <th className="px-4 py-3">当前</th>
              <th className="px-4 py-3">导入后</th>
              <th className="px-4 py-3 text-teal-700">新增</th>
              <th className="px-4 py-3 text-amber-700">覆盖</th>
              <th className="px-4 py-3 text-red-700">移除</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {preview.metrics.map(metric => (
              <tr key={metric.label}>
                <td className="px-4 py-3 font-medium text-slate-800">{metric.label}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{metric.current}</td>
                <td className="px-4 py-3 font-mono text-slate-600">{metric.incoming}</td>
                <td className="px-4 py-3 font-mono text-teal-700">{metric.added}</td>
                <td className="px-4 py-3 font-mono text-amber-700">{metric.overwritten}</td>
                <td className="px-4 py-3 font-mono text-red-700">{metric.removed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[
          { title: '新增患者示例', items: preview.samples.addedPatients },
          { title: '覆盖患者示例', items: preview.samples.overwrittenPatients },
          { title: '移除患者示例', items: preview.samples.removedPatients }
        ].map(group => (
          <div key={group.title} className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="font-bold text-slate-700">{group.title}</div>
            {group.items.length > 0 ? (
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {group.items.map(item => <li key={item} className="truncate">{item}</li>)}
              </ul>
            ) : (
              <div className="mt-2 text-sm text-slate-400">无</div>
            )}
          </div>
        ))}
      </div>

      {preview.warnings.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
          <div className="font-bold text-slate-700">风险提示</div>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {preview.warnings.map(warning => <li key={warning}>{warning}</li>)}
          </ul>
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2">
        <Button variant="secondary" onClick={onCancel} size="lg" disabled={isImporting}>取消</Button>
        <Button variant="danger" onClick={onConfirm} size="lg" disabled={isImporting}>
          {isImporting ? '正在导入…' : '确认覆盖导入'}
        </Button>
      </div>
    </div>
  </ModalBase>
);
