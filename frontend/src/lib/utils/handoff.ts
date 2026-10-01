/**
 * 离线交接引擎
 * - 导出交接包（各机一批，含基线快照）
 * - 解析校验交接包
 * - 三区合并（base / 本地 / 包内）：新增、修改、撤回、冲突
 * - 冲突按实体类型裁决：印石 / 印稿字段级裁决；工序两边保留并重排；钤印按日期+纸张去重
 * - 事务性生效，失败可还原
 */
import { db, captureSnapshot, readBaseSnapshot, writeBaseSnapshot, saveRestorePoint, readRestorePoint, clearRestorePoint, type BaseSnapshot } from '$lib/utils/db';
import {
  GRADE_WEIGHT,
  type Impression,
} from '$lib/types/impression';
import { KNIFE_METHOD_LABEL, STANDARD_KNIFE_SEQUENCE, type Carve, type KnifeMethod } from '$lib/types/carve';
import type { Stone } from '$lib/types/stone';
import type { Design } from '$lib/types/design';
import type { Catalog } from '$lib/types/catalog';
import {
  HANDOFF_APP,
  HANDOFF_KIND,
  HANDOFF_SCHEMA_VERSION,
  TABLE_LABEL,
  type BatchMeta,
  type BatchRecord,
  type FieldConflict,
  type HandoffPackage,
  type HandoffRecord,
  type MergeChange,
  type MergePreview,
  type MergeResult,
  type TableName,
} from '$lib/types/batch';

const TABLES: TableName[] = ['stones', 'designs', 'carves', 'impressions', 'catalogs'];

/** 各表参与「业务内容」比对的字段（排除批次 / 撤回 / 时间戳元数据） */
const BUSINESS_FIELDS: Record<TableName, string[]> = {
  stones: ['name', 'stoneType', 'sizeMm', 'knobStyle', 'purchaseDate', 'state'],
  designs: ['stoneId', 'sealText', 'annotation', 'style', 'borderStyle', 'layoutNote', 'adopted'],
  carves: ['designId', 'seq', 'knifeMethod', 'minutes', 'operator', 'state'],
  impressions: ['designId', 'inkBrand', 'paperType', 'pressure', 'grade', 'stampedAt', 'note'],
  catalogs: ['stoneId', 'designId', 'orderNo', 'included', 'note'],
};

/** 印石字段标签（裁决展示用） */
const STONE_FIELD_LABELS: Record<string, string> = {
  name: '印石名',
  stoneType: '石种',
  sizeMm: '尺寸',
  knobStyle: '钮式',
  purchaseDate: '购入日期',
  state: '状态',
};

/** 印稿字段标签 */
const DESIGN_FIELD_LABELS: Record<string, string> = {
  stoneId: '所属印石',
  sealText: '印文',
  annotation: '释文',
  style: '朱白文',
  borderStyle: '边框式样',
  layoutNote: '章法备注',
  adopted: '采用稿',
};

function fieldLabel(table: TableName, field: string): string {
  if (table === 'stones') return STONE_FIELD_LABELS[field] ?? field;
  if (table === 'designs') return DESIGN_FIELD_LABELS[field] ?? field;
  return field;
}

function asRecord(r: HandoffRecord): Record<string, unknown> {
  return r as unknown as Record<string, unknown>;
}

function businessEqual(table: TableName, a: HandoffRecord, b: HandoffRecord): boolean {
  const fields = BUSINESS_FIELDS[table];
  const ra = asRecord(a);
  const rb = asRecord(b);
  return fields.every((field) => ra[field] === rb[field]);
}

function businessDiff(table: TableName, a: HandoffRecord, b: HandoffRecord): string[] {
  const ra = asRecord(a);
  const rb = asRecord(b);
  return BUSINESS_FIELDS[table].filter((field) => ra[field] !== rb[field]);
}

/** 生成批次号：yyyyMMdd-HHmm */
export function batchNo(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

export interface ExportMachineInfo {
  machineId: string;
  machineName: string;
  operator: string;
  note: string;
}

/** 导出交接包：全量五表（含撤回）+ 批次元信息 + 基线快照 */
export async function exportHandoffPackage(info: ExportMachineInfo): Promise<HandoffPackage> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  const base = readBaseSnapshot();
  const batch: BatchMeta = {
    id: `batch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    no: batchNo(),
    machineId: info.machineId,
    machineName: info.machineName || '未命名机器',
    operator: info.operator || '未填写',
    exportedAt: new Date().toISOString(),
    note: info.note,
  };
  const baseMap = {} as Record<TableName, HandoffRecord[]>;
  for (const table of TABLES) {
    baseMap[table] = ((base?.[table] ?? []) as unknown as HandoffRecord[]);
  }
  return {
    app: HANDOFF_APP,
    kind: HANDOFF_KIND,
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    batch,
    base: baseMap,
    stones,
    designs,
    carves,
    impressions,
    catalogs,
  };
}

/** 触发交接包下载 */
export function downloadHandoffPackage(pkg: HandoffPackage): void {
  const filename = `gbsealcarve-handoff-${pkg.batch.no}.json`;
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** 解析交接包文本并校验，返回错误文案（空串表示通过） */
export function parseHandoffPackage(text: string): { pkg: HandoffPackage | null; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { pkg: null, error: 'JSON 解析失败，请确认文件格式' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { pkg: null, error: '文件内容不是合法的 JSON 对象' };
  }
  const raw = parsed as Partial<HandoffPackage>;
  if (raw.app !== HANDOFF_APP) return { pkg: null, error: `交接包不属于本项目（app=${String(raw.app)}）` };
  if (raw.kind !== HANDOFF_KIND) return { pkg: null, error: `文件不是交接包（kind=${String(raw.kind)}），请使用「导出交接包」` };
  if (!raw.batch || typeof raw.batch.id !== 'string') return { pkg: null, error: '缺少批次信息（batch）' };
  for (const table of TABLES) {
    if (!Array.isArray(raw[table])) return { pkg: null, error: `交接包缺少 ${TABLE_LABEL[table]} 集合` };
  }
  if (raw.schemaVersion !== undefined && typeof raw.schemaVersion === 'number' && raw.schemaVersion > HANDOFF_SCHEMA_VERSION) {
    return { pkg: null, error: `交接包版本 v${raw.schemaVersion} 高于本机 v${HANDOFF_SCHEMA_VERSION}，请升级后再导入` };
  }
  return { pkg: raw as HandoffPackage, error: '' };
}

/** 取记录标题（预览展示用） */
function recordTitle(table: TableName, record: HandoffRecord, designs: Design[]): string {
  if (table === 'stones') return (record as Stone).name || '（未命名印石）';
  if (table === 'designs') return (record as Design).sealText || '（未命名印稿）';
  if (table === 'carves') {
    const carve = record as Carve;
    const design = designs.find((d) => d.id === carve.designId);
    return design ? `${design.sealText} · ${KNIFE_METHOD_LABEL[carve.knifeMethod]}工序` : '（未知印稿工序）';
  }
  if (table === 'impressions') {
    const impression = record as Impression;
    const design = designs.find((d) => d.id === impression.designId);
    return design ? `${design.sealText} · ${impression.stampedAt} 钤印` : '（未知印稿钤印）';
  }
  const catalog = record as Catalog;
  const design = designs.find((d) => d.id === catalog.designId);
  return design ? `${design.sealText}（印谱第 ${catalog.orderNo} 位）` : '（未知印谱条目）';
}

/** 取记录所属印石名 */
function recordStoneName(table: TableName, record: HandoffRecord, stones: Stone[], designs: Design[]): string | undefined {
  if (table === 'stones') return undefined;
  if (table === 'designs') return stones.find((s) => s.id === (record as Design).stoneId)?.name;
  if (table === 'carves') {
    const design = designs.find((d) => d.id === (record as Carve).designId);
    return design ? stones.find((s) => s.id === design.stoneId)?.name : undefined;
  }
  if (table === 'impressions') {
    const design = designs.find((d) => d.id === (record as Impression).designId);
    return design ? stones.find((s) => s.id === design.stoneId)?.name : undefined;
  }
  return stones.find((s) => s.id === (record as Catalog).stoneId)?.name;
}

/**
 * 计算合并预览（三区合并）
 * base 缺失时退化为 updatedAt 时间戳合并。
 */
export async function computeMergePreview(pkg: HandoffPackage): Promise<MergePreview> {
  const [localStones, localDesigns, localCarves, localImpressions, localCatalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  const localMap: Record<TableName, HandoffRecord[]> = {
    stones: localStones,
    designs: localDesigns,
    carves: localCarves,
    impressions: localImpressions,
    catalogs: localCatalogs,
  };
  const remoteMap: Record<TableName, HandoffRecord[]> = {
    stones: pkg.stones,
    designs: pkg.designs,
    carves: pkg.carves,
    impressions: pkg.impressions,
    catalogs: pkg.catalogs,
  };
  const hasBase = pkg.base && TABLES.every((t) => Array.isArray(pkg.base[t]));
  const baseMap: Record<TableName, HandoffRecord[]> = hasBase
    ? pkg.base
    : ({ stones: [], designs: [], carves: [], impressions: [], catalogs: [] } as Record<TableName, HandoffRecord[]>);

  const changes: MergeChange[] = [];
  let addCount = 0;
  let modifyCount = 0;
  let withdrawCount = 0;
  let conflictCount = 0;

  for (const table of TABLES) {
    const locals = localMap[table];
    const remotes = remoteMap[table];
    const bases = baseMap[table];
    const localById = new Map(locals.map((r) => [r.id, r]));
    const remoteById = new Map(remotes.map((r) => [r.id, r]));
    const baseById = new Map(bases.map((r) => [r.id, r]));

    const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);
    allIds.forEach((id) => {
      const local = localById.get(id);
      const remote = remoteById.get(id);
      const base = baseById.get(id);

      const title = recordTitle(table, (remote ?? local) as HandoffRecord, localDesigns);
      const stoneName = recordStoneName(table, (remote ?? local) as HandoffRecord, localStones, localDesigns);

      // 仅包内有 → 新增 或 撤回
      if (remote && !local) {
        if (remote.withdrawn) {
          // 包内撤回了一个本地没有的记录：本地无操作，不计入变更
          return;
        }
        if (base) {
          // 基线有、本地无 → 本地撤回了该记录，包内仍保留（可能改过）→ 冲突
          changes.push({ kind: 'conflict', table, recordId: id, title, stoneName });
          conflictCount += 1;
        } else {
          changes.push({ kind: 'add', table, recordId: id, title, stoneName });
          addCount += 1;
        }
        return;
      }

      // 仅本地有 → 本地新增（合并到本地时无操作）；基线有而包内无 → 包内撤回
      if (local && !remote) {
        if (base && !local.withdrawn) {
          changes.push({ kind: 'withdraw', table, recordId: id, title, stoneName, withdrawnAt: Date.now() });
          withdrawCount += 1;
        }
        return;
      }

      // 两边都有
      if (!local || !remote) return;

      // 撤回状态处理
      if (remote.withdrawn && !local.withdrawn) {
        changes.push({ kind: 'withdraw', table, recordId: id, title, stoneName, withdrawnAt: Date.now() });
        withdrawCount += 1;
        return;
      }
      if (local.withdrawn && !remote.withdrawn) {
        // 本地已撤回、包内仍保留 → 冲突（撤回 vs 保留）
        changes.push({ kind: 'conflict', table, recordId: id, title, stoneName });
        conflictCount += 1;
        return;
      }
      if (local.withdrawn && remote.withdrawn) return;

      // 两边都有效：比对业务内容
      if (businessEqual(table, local, remote)) return;

      // 内容不同：判断哪一边改过
      const remoteChanged = base ? !businessEqual(table, base, remote) : remote.updatedAt > local.updatedAt;
      const localChanged = base ? !businessEqual(table, base, local) : local.updatedAt >= remote.updatedAt;

      if (remoteChanged && !localChanged) {
        changes.push({
          kind: 'modify',
          table,
          recordId: id,
          title,
          stoneName,
          changedFields: businessDiff(table, local, remote).map((f) => fieldLabel(table, f)),
        });
        modifyCount += 1;
        return;
      }
      if (!remoteChanged && localChanged) {
        // 仅本地改过：保留本地，无操作
        return;
      }

      // 两边都改过 → 冲突
      if (table === 'stones' || table === 'designs') {
        const diffFields = businessDiff(table, local, remote);
        const fieldConflicts: FieldConflict[] = diffFields.map((field) => ({
          table,
          recordId: id,
          field,
          fieldLabel: fieldLabel(table, field),
          localValue: asRecord(local)[field],
          remoteValue: asRecord(remote)[field],
          choice: 'remote',
        }));
        changes.push({ kind: 'conflict', table, recordId: id, title, stoneName, fieldConflicts });
      } else {
        // 工序 / 钤印 / 印谱：特殊合并（保留两边 / 去重 / 重算），计入冲突但自动裁决
        changes.push({ kind: 'conflict', table, recordId: id, title, stoneName });
      }
      conflictCount += 1;
    });
  }

  return {
    batch: pkg.batch,
    changes,
    addCount,
    modifyCount,
    withdrawCount,
    conflictCount,
    recordCount: TABLES.reduce((sum, t) => sum + remoteMap[t].length, 0),
    hasBase,
  };
}

/** 工序排序：按时长（分钟）降序，同时长按标准刀法序列，再相同按 id */
function carveSortKey(carve: Carve): [number, number, string] {
  const methodOrder = STANDARD_KNIFE_SEQUENCE.indexOf(carve.knifeMethod as KnifeMethod);
  return [-carve.minutes, methodOrder < 0 ? 99 : methodOrder, carve.id];
}

/** 比较两个钤印的「重复键」：同印稿 + 同钤印日期 + 同纸张 */
function impressionDupKey(impression: Impression): string {
  return `${impression.designId}|${impression.stampedAt}|${impression.paperType}`;
}

/** 两条钤印取较优者（评级高者胜，同级取备注长者，再同级取本地） */
function betterImpression(a: Impression, b: Impression): Impression {
  const wa = GRADE_WEIGHT[a.grade] ?? 0;
  const wb = GRADE_WEIGHT[b.grade] ?? 0;
  if (wa !== wb) return wa > wb ? a : b;
  if (a.note.length !== b.note.length) return a.note.length > b.note.length ? a : b;
  return a;
}

/** 根据预览与裁决选择，计算各表最终记录 */
function resolveFinalRecords(
  pkg: HandoffPackage,
  preview: MergePreview,
): Record<TableName, HandoffRecord[]> {
  const result = {} as Record<TableName, HandoffRecord[]>;
  for (const table of TABLES) {
    result[table] = [];
  }

  const changeMap = new Map<string, MergeChange>();
  preview.changes.forEach((change) => changeMap.set(`${change.table}:${change.recordId}`, change));

  const now = Date.now();
  const batchId = pkg.batch.id;

  // ---- 印石 / 印稿：字段级裁决 ----
  for (const table of ['stones', 'designs'] as TableName[]) {
    const remoteList = pkg[table] as HandoffRecord[];
    const baseById = new Map((pkg.base[table] ?? []).map((r) => [r.id, r]));

    // 以本地为底（含撤回记录，保留以便后续传播）
    const currentLocal = table === 'stones' ? currentStones : currentDesigns;
    const finalRows: HandoffRecord[] = currentLocal.map((row) => ({ ...row }));
    const finalById = new Map(finalRows.map((r) => [r.id, r]));

    remoteList.forEach((remote) => {
      const change = changeMap.get(`${table}:${remote.id}`);
      const local = finalById.get(remote.id);

      if (remote.withdrawn) {
        if (local) {
          Object.assign(local, { withdrawn: true, updatedAt: now, batchId });
        }
        return;
      }

      if (!local) {
        // 新增
        finalRows.push({ ...remote, batchId, withdrawn: false, createdAt: remote.createdAt || now, updatedAt: now });
        return;
      }

      // 两边都有且有效
      if (change?.kind === 'modify') {
        Object.assign(local, { ...remote, id: local.id, batchId, withdrawn: false, updatedAt: now });
        return;
      }
      if (change?.kind === 'conflict' && change.fieldConflicts) {
        // 字段级裁决
        const base = baseById.get(remote.id);
        const merged: Record<string, unknown> = { ...asRecord(local) };
        const conflictFields = new Set(change.fieldConflicts.map((fc) => fc.field));
        change.fieldConflicts.forEach((fc) => {
          merged[fc.field] = fc.choice === 'remote' ? asRecord(remote)[fc.field] : asRecord(local)[fc.field];
        });
        // 未冲突字段：若包内改过则用包内，否则保留本地
        BUSINESS_FIELDS[table].forEach((field) => {
          if (conflictFields.has(field)) return;
          const remoteChanged = base ? asRecord(remote)[field] !== asRecord(base)[field] : false;
          if (remoteChanged) merged[field] = asRecord(remote)[field];
        });
        Object.assign(local, merged, { batchId, withdrawn: false, updatedAt: now });
        return;
      }
      // 无变化或仅本地改过：保留本地
    });

    result[table] = finalRows;
  }

  // ---- 工序：保留两边记录，按刀法时长重排 ----
  {
    const localCarves = currentCarves;
    const remoteCarves = pkg.carves;
    const finalById = new Map<string, Carve>();

    // 以本地为底（含撤回记录，保留以便后续传播）
    localCarves.forEach((carve) => {
      finalById.set(carve.id, { ...carve });
    });

    remoteCarves.forEach((remote) => {
      if (remote.withdrawn) {
        const local = finalById.get(remote.id);
        if (local) finalById.set(remote.id, { ...local, withdrawn: true, updatedAt: now, batchId });
        return;
      }
      const local = finalById.get(remote.id);
      if (!local || local.withdrawn) {
        // 新增（本地无或已撤回）
        finalById.set(remote.id, { ...remote, batchId, withdrawn: false, updatedAt: now });
      } else if (!businessEqual('carves', local, remote)) {
        // 两边都改过同一工序：保留两边，包内版本复制为新记录
        const cloned: Carve = {
          ...remote,
          id: `carve_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
          seq: 0,
          batchId,
          withdrawn: false,
          createdAt: now,
          updatedAt: now,
        };
        finalById.set(cloned.id, cloned);
      }
    });

    // 按印稿分组重排（仅有效工序参与）
    const byDesign = new Map<string, Carve[]>();
    finalById.forEach((carve) => {
      if (carve.withdrawn) return;
      const list = byDesign.get(carve.designId) ?? [];
      list.push(carve);
      byDesign.set(carve.designId, list);
    });
    const merged: Carve[] = [];
    byDesign.forEach((list) => {
      list.sort((a, b) => {
        const ka = carveSortKey(a);
        const kb = carveSortKey(b);
        return ka[0] - kb[0] || ka[1] - kb[1] || ka[2].localeCompare(kb[2]);
      });
      list.forEach((carve, index) => {
        merged.push({ ...carve, seq: index + 1, batchId, updatedAt: now });
      });
    });
    // 撤回工序原样保留（不参与排序）
    finalById.forEach((carve) => {
      if (carve.withdrawn) merged.push({ ...carve, batchId });
    });
    result.carves = merged;
  }

  // ---- 钤印：按印稿+日期+纸张去重 ----
  {
    const localImpressions = currentImpressions;
    const remoteImpressions = pkg.impressions;
    const finalList: Impression[] = [];
    const finalById = new Map<string, Impression>();
    const dupKeyIndex = new Map<string, Impression>();

    localImpressions.forEach((impression) => {
      const copy = { ...impression };
      finalList.push(copy);
      finalById.set(copy.id, copy);
      if (!copy.withdrawn) dupKeyIndex.set(impressionDupKey(copy), copy);
    });

    remoteImpressions.forEach((remote) => {
      if (remote.withdrawn) {
        const local = finalById.get(remote.id);
        if (local && !local.withdrawn) {
          const idx = finalList.findIndex((r) => r.id === remote.id);
          if (idx >= 0) finalList[idx] = { ...local, withdrawn: true, updatedAt: now, batchId };
        }
        return;
      }
      const local = finalById.get(remote.id);
      if (local && !local.withdrawn) {
        if (businessEqual('impressions', local, remote)) return;
        // 两边都改过：若重复键相同则去重取较优，否则保留两边
        if (impressionDupKey(local) === impressionDupKey(remote)) {
          const better = betterImpression(local, remote);
          const idx = finalList.findIndex((r) => r.id === remote.id);
          if (idx >= 0) finalList[idx] = { ...better, batchId, updatedAt: now };
        } else {
          // 日期或纸张变了：视为不同钤印，保留包内
          finalList.push({ ...remote, batchId, withdrawn: false, updatedAt: now });
        }
        return;
      }
      // 本地无此 id 或已撤回：检查重复键
      const dupKey = impressionDupKey(remote);
      const existing = dupKeyIndex.get(dupKey);
      if (existing) {
        const better = betterImpression(existing, remote);
        const idx = finalList.findIndex((r) => r.id === existing.id);
        if (idx >= 0) finalList[idx] = { ...better, batchId, updatedAt: now };
      } else {
        const copy = { ...remote, batchId, withdrawn: false, updatedAt: now };
        finalList.push(copy);
        finalById.set(copy.id, copy);
        dupKeyIndex.set(dupKey, copy);
      }
    });

    result.impressions = finalList;
  }

  // ---- 印谱条目：合并后统一重算排序 ----
  {
    const localCatalogs = currentCatalogs;
    const remoteCatalogs = pkg.catalogs;
    const finalById = new Map<string, Catalog>();

    localCatalogs.forEach((catalog) => {
      finalById.set(catalog.id, { ...catalog });
    });

    remoteCatalogs.forEach((remote) => {
      if (remote.withdrawn) {
        const local = finalById.get(remote.id);
        if (local && !local.withdrawn) {
          finalById.set(remote.id, { ...local, withdrawn: true, updatedAt: now, batchId });
        }
        return;
      }
      const local = finalById.get(remote.id);
      if (!local || local.withdrawn) {
        finalById.set(remote.id, { ...remote, batchId, withdrawn: false, updatedAt: now });
      } else if (!businessEqual('catalogs', local, remote)) {
        // 两边都改过：保留包内（排序稍后统一重算）
        finalById.set(remote.id, { ...remote, id: local.id, batchId, withdrawn: false, updatedAt: now });
      }
    });

    // 仅有效条目参与排序重编号
    const active = [...finalById.values()].filter((c) => !c.withdrawn);
    active.sort((a, b) => (a.orderNo === b.orderNo ? a.createdAt - b.createdAt : a.orderNo - b.orderNo));
    const merged: Catalog[] = active.map((catalog, index) => ({
      ...catalog,
      orderNo: index + 1,
      batchId,
      updatedAt: now,
    }));
    // 撤回条目原样保留
    finalById.forEach((catalog) => {
      if (catalog.withdrawn) merged.push({ ...catalog, batchId });
    });
    result.catalogs = merged;
  }

  return result;
}

// 当前本地数据快照（resolveFinalRecords 内部使用，由 applyMerge 注入）
let currentStones: Stone[] = [];
let currentDesigns: Design[] = [];
let currentCarves: Carve[] = [];
let currentImpressions: Impression[] = [];
let currentCatalogs: Catalog[] = [];

/** 应用合并：事务性写入，失败可还原 */
export async function applyMerge(
  pkg: HandoffPackage,
  preview: MergePreview,
): Promise<MergeResult> {
  // 1. 保存还原点
  const restoreSnapshot = await captureSnapshot();
  saveRestorePoint({
    savedAt: new Date().toISOString(),
    reason: `导入交接包 ${pkg.batch.no} 前快照`,
    ...restoreSnapshot,
  });

  // 2. 读取当前本地数据（供 resolveFinalRecords 使用）
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  currentStones = stones;
  currentDesigns = designs;
  currentCarves = carves;
  currentImpressions = impressions;
  currentCatalogs = catalogs;

  // 3. 计算最终记录
  const finalRecords = resolveFinalRecords(pkg, preview);

  // 4. 事务性写入
  try {
    await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs, db.batches], async () => {
      await Promise.all([
        db.stones.clear(),
        db.designs.clear(),
        db.carves.clear(),
        db.impressions.clear(),
        db.catalogs.clear(),
      ]);
      await Promise.all([
        db.stones.bulkPut(finalRecords.stones as Stone[]),
        db.designs.bulkPut(finalRecords.designs as Design[]),
        db.carves.bulkPut(finalRecords.carves as Carve[]),
        db.impressions.bulkPut(finalRecords.impressions as Impression[]),
        db.catalogs.bulkPut(finalRecords.catalogs as Catalog[]),
      ]);
      const recordCount = TABLES.reduce((sum, t) => sum + finalRecords[t].length, 0);
      const batchRecord: BatchRecord = {
        ...pkg.batch,
        importedAt: new Date().toISOString(),
        recordCount,
      };
      await db.batches.put(batchRecord);
    });
  } catch (err) {
    // 事务失败自动回滚；抛出由调用方提示
    throw new Error(`合并写入失败，已回滚：${err instanceof Error ? err.message : String(err)}`);
  }

  // 5. 更新基线快照为合并结果
  const newBase: BaseSnapshot = {
    exportedAt: new Date().toISOString(),
    stones: finalRecords.stones,
    designs: finalRecords.designs,
    carves: finalRecords.carves,
    impressions: finalRecords.impressions,
    catalogs: finalRecords.catalogs,
  };
  writeBaseSnapshot(newBase);

  return {
    appliedAt: new Date().toISOString(),
    batch: pkg.batch,
    addCount: preview.addCount,
    modifyCount: preview.modifyCount,
    withdrawCount: preview.withdrawCount,
    conflictCount: preview.conflictCount,
    catalogCount: finalRecords.catalogs.length,
  };
}

/** 从还原点恢复（导入失败或撤销后） */
export async function restoreFromRestorePoint(): Promise<void> {
  const point = readRestorePoint();
  if (!point) throw new Error('没有可恢复的还原点');
  await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs], async () => {
    await Promise.all([
      db.stones.clear(),
      db.designs.clear(),
      db.carves.clear(),
      db.impressions.clear(),
      db.catalogs.clear(),
    ]);
    await Promise.all([
      db.stones.bulkPut(point.stones as Stone[]),
      db.designs.bulkPut(point.designs as Design[]),
      db.carves.bulkPut(point.carves as Carve[]),
      db.impressions.bulkPut(point.impressions as Impression[]),
      db.catalogs.bulkPut(point.catalogs as Catalog[]),
    ]);
  });
  clearRestorePoint();
}

/** 列出已导入批次（按导入时间倒序） */
export async function listBatches(): Promise<BatchRecord[]> {
  const rows = await db.batches.toArray();
  return rows.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
