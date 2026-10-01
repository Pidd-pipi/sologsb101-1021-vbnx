/**
 * 离线交接 store
 * 维护交接包解析、合并预览（含字段裁决选择）、生效与批次留档。
 * 页面只读 store 并调用导出的动作函数。
 */
import { get, writable } from 'svelte/store';
import {
  applyMerge,
  computeMergePreview,
  downloadHandoffPackage,
  exportHandoffPackage,
  listBatches,
  parseHandoffPackage,
  restoreFromRestorePoint,
  type ExportMachineInfo,
} from '$lib/utils/handoff';
import { getMachineId } from '$lib/utils/db';
import type { BatchRecord, FieldConflict, HandoffPackage, MergePreview } from '$lib/types/batch';
import { tabGuard } from '$lib/utils/tabGuard';

/** 本机信息（导出交接包时用，存 localStorage） */
const MACHINE_INFO_KEY = 'gbsealcarve:machine-info';

export interface MachineInfo {
  machineName: string;
  operator: string;
  note: string;
}

export const DEFAULT_MACHINE_INFO: MachineInfo = {
  machineName: '',
  operator: '',
  note: '',
};

export function readMachineInfo(): MachineInfo {
  try {
    const raw = localStorage.getItem(MACHINE_INFO_KEY);
    if (!raw) return { ...DEFAULT_MACHINE_INFO };
    const parsed = JSON.parse(raw) as Partial<MachineInfo>;
    return {
      machineName: typeof parsed.machineName === 'string' ? parsed.machineName : '',
      operator: typeof parsed.operator === 'string' ? parsed.operator : '',
      note: typeof parsed.note === 'string' ? parsed.note : '',
    };
  } catch {
    return { ...DEFAULT_MACHINE_INFO };
  }
}

export function writeMachineInfo(info: MachineInfo): void {
  try {
    localStorage.setItem(MACHINE_INFO_KEY, JSON.stringify(info));
  } catch {
    /* 隐私模式忽略 */
  }
}

export const machineInfo = writable<MachineInfo>(readMachineInfo());

machineInfo.subscribe((value) => writeMachineInfo(value));

/** 当前解析的交接包 */
export const handoffPackage = writable<HandoffPackage | null>(null);
/** 当前合并预览 */
export const mergePreview = writable<MergePreview | null>(null);
/** 解析 / 预览错误 */
export const handoffError = writable('');
/** 是否正在解析 */
export const handoffParsing = writable(false);
/** 是否正在生效 */
export const handoffApplying = writable(false);
/** 已导入批次留档 */
export const batchRecords = writable<BatchRecord[]>([]);
/** 最近一次生效结果提示 */
export const handoffToast = writable('');

/** 解析交接包文本并生成预览 */
export async function loadHandoffFromText(text: string): Promise<boolean> {
  handoffParsing.set(true);
  handoffError.set('');
  try {
    const { pkg, error } = parseHandoffPackage(text);
    if (error || !pkg) {
      handoffError.set(error || '交接包解析失败');
      return false;
    }
    const preview = await computeMergePreview(pkg);
    handoffPackage.set(pkg);
    mergePreview.set(preview);
    return true;
  } catch (err) {
    handoffError.set(err instanceof Error ? err.message : '交接包解析失败');
    return false;
  } finally {
    handoffParsing.set(false);
  }
}

/** 清除当前预览 */
export function clearPreview(): void {
  handoffPackage.set(null);
  mergePreview.set(null);
  handoffError.set('');
}

/** 更新字段冲突裁决选择 */
export function setFieldChoice(changeKey: string, field: string, choice: 'local' | 'remote'): void {
  const preview = get(mergePreview);
  if (!preview) return;
  const change = preview.changes.find((c) => `${c.table}:${c.recordId}` === changeKey);
  if (!change || !change.fieldConflicts) return;
  const conflict = change.fieldConflicts.find((fc) => fc.field === field);
  if (!conflict) return;
  conflict.choice = choice;
  mergePreview.set({ ...preview });
}

/** 批量设置某条冲突的全部字段选择 */
export function setAllFieldChoices(changeKey: string, choice: 'local' | 'remote'): void {
  const preview = get(mergePreview);
  if (!preview) return;
  const change = preview.changes.find((c) => `${c.table}:${c.recordId}` === changeKey);
  if (!change || !change.fieldConflicts) return;
  change.fieldConflicts.forEach((fc) => (fc.choice = choice));
  mergePreview.set({ ...preview });
}

/** 生效合并 */
export async function confirmMerge(): Promise<boolean> {
  const pkg = get(handoffPackage);
  const preview = get(mergePreview);
  if (!pkg || !preview) return false;
  handoffApplying.set(true);
  handoffError.set('');
  try {
    await applyMerge(pkg, preview);
    tabGuard.markLocalWrite(`导入交接包 ${pkg.batch.no}`);
    clearPreview();
    await loadBatchRecords();
    handoffToast.set(`交接包 ${pkg.batch.no} 已生效：新增 ${preview.addCount} · 修改 ${preview.modifyCount} · 撤回 ${preview.withdrawCount} · 冲突 ${preview.conflictCount}`);
    return true;
  } catch (err) {
    handoffError.set(err instanceof Error ? err.message : '合并失败');
    return false;
  } finally {
    handoffApplying.set(false);
  }
}

/** 从还原点恢复（撤销导入） */
export async function undoLastMerge(): Promise<boolean> {
  handoffApplying.set(true);
  handoffError.set('');
  try {
    await restoreFromRestorePoint();
    tabGuard.markLocalWrite('撤销最近一次交接导入');
    handoffToast.set('已恢复到导入前状态');
    return true;
  } catch (err) {
    handoffError.set(err instanceof Error ? err.message : '恢复失败');
    return false;
  } finally {
    handoffApplying.set(false);
  }
}

/** 导出本机交接包 */
export async function exportCurrentHandoff(): Promise<string> {
  const info = get(machineInfo);
  const exportInfo: ExportMachineInfo = {
    machineId: getMachineId(),
    machineName: info.machineName,
    operator: info.operator,
    note: info.note,
  };
  const pkg = await exportHandoffPackage(exportInfo);
  downloadHandoffPackage(pkg);
  return pkg.batch.no;
}

/** 载入已导入批次留档 */
export async function loadBatchRecords(): Promise<void> {
  try {
    const rows = await listBatches();
    batchRecords.set(rows);
  } catch {
    batchRecords.set([]);
  }
}

/** 取字段冲突的展示值 */
export function fieldDisplayValue(fc: FieldConflict, side: 'local' | 'remote'): string {
  const value = side === 'local' ? fc.localValue : fc.remoteValue;
  if (value === undefined || value === null || value === '') return '（空）';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
