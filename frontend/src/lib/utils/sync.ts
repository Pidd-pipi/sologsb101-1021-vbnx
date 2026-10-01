/**
 * 离线交接核心（纯函数，不直接读写数据库）
 *
 * 场景：印社多台笔记本在无网会场各自补刻制工序、换采用稿、登记钤印，
 * 回社后导入「离线交接包」做三方合并（基线 base / 本机 local / 对方 incoming），
 * 先列「新增 / 修改 / 撤回 / 冲突」，确认后一起生效。
 *
 * 合并要点：
 * - 印石信息双方都改 → 冲突，进入人工裁决（保留本机 / 采用对方）。
 * - 同一印稿的工序两边都改过 → 不覆盖，两边记录都保留，按刀法时长重排序号。
 * - 钤印重复（同稿、同钤印日期、同纸张）→ 按评级优先、再按更新时间择优保留。
 * - 撤回（软删除）通过 withdrawn 标记同步；本机已改、对方撤回 → 冲突。
 *
 * 批次：每次外地评审前由 handoff.ts 建立「活动批次」，批次基线为开批时的全量快照；
 * 交接包只携带本批改动行 + 改动行在基线中的旧值，保证三方 diff 不依赖各机时钟一致。
 */
import type { Design } from '$lib/types/design';
import type { Carve } from '$lib/types/carve';
import type { Impression, Grade } from '$lib/types/impression';
import { GRADE_WEIGHT as GRADE_WEIGHT_VALUE } from '$lib/types/impression';
import { DB_NAME } from './db';

/** 交接包适用的结构版本（与 db.ts 的 DB_VERSION 保持一致，单独定义避免循环依赖） */
export const HANDOFF_SCHEMA_VERSION = 3;

export const TABLE_NAMES = ['stones', 'designs', 'carves', 'impressions', 'catalogs'] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** 任意一张业务表的行（含离线交接同步字段；具体实体结构兼容本接口） */
export interface SyncRow {
  id: string;
  batchId?: string;
  withdrawn?: boolean;
  withdrawnAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
}

export type LocalData = Record<TableName, SyncRow[]>;

/** 旧数据迁移时归入的批次标记（旧数据打开后自动补批次与撤回标记） */
export const LEGACY_BATCH_ID = 'legacy';
/** 整库覆盖导入旧备份时归入的批次标记（旧备份导入即视为一批，自动补批次与撤回标记） */
export const IMPORTED_BATCH_ID = 'imported-full';

/** 交接包三方合并时一条行级变更的分类 */
export type ChangeKind = 'add' | 'update' | 'withdraw' | 'conflict' | 'skip';

/** 冲突裁决选项：保留本机 / 采用对方 /（撤回冲突时）保留本机即忽略撤回 */
export type ConflictResolution = 'local' | 'incoming';

/** 冲突子类型 */
export type ConflictReason =
  | 'both-modified' // 两边都修改了同一记录
  | 'local-modified-remote-withdrawn' // 本机改过，对方撤回
  | 'local-withdrawn-remote-modified'; // 本机撤回，对方改过

export interface MergeItem {
  table: TableName;
  id: string;
  kind: ChangeKind;
  /** 生效时写入的行（add / update）；withdraw / conflict 按裁决结果生成 */
  incoming?: SyncRow;
  local?: SyncRow;
  base?: SyncRow;
  /** withdraw 撤回时间（取对方） */
  withdrawnAt?: number | null;
}

export interface ConflictItem {
  table: TableName;
  id: string;
  reason: ConflictReason;
  local: SyncRow;
  incoming: SyncRow;
  base?: SyncRow;
  /** 默认裁决：工序以外按更新时间晚者优先；可在审核界面修改 */
  resolution: ConflictResolution;
}

/** 同稿工序两边都改：合并后保留两边记录，按刀法时长重排的预览行 */
export interface CarveMergeGroup {
  designId: string;
  /** 合并后全部工序（已按刀法时长升序、同长按创建时间排序、重排序号） */
  merged: Carve[];
  /** 来自对方、本机原已存在同 id 因而需换新 id 的工序 id 映射 */
  remappedIds: Array<{ oldId: string; newId: string }>;
}

/** 钤印重复（同稿 + 同钤印日期 + 同纸张）择优组 */
export interface ImpressionDupGroup {
  designId: string;
  stampedAt: string;
  paperType: string;
  winner: Impression;
  losers: Impression[];
}

export interface MergePlan {
  items: MergeItem[];
  conflicts: ConflictItem[];
  /** 工序双改合并组（自动保留两边并按时长重排） */
  carveGroups: CarveMergeGroup[];
  /** 钤印重复择优组（自动按评级/日期识别） */
  impressionDups: ImpressionDupGroup[];
  adds: MergeItem[];
  updates: MergeItem[];
  withdraws: MergeItem[];
  skips: MergeItem[];
  /** 解析时附带的本机数据，供界面展示标题；不参与序列化 */
  local: LocalData;
}

/* ------------------------------ 行规范化 ------------------------------ */

/** 补齐离线交接同步字段（旧数据 / 旧备份打开后自动补批次和撤回标记） */
export function normalizeSyncRow<T extends SyncRow>(row: T, fallbackBatchId: string): T {
  return {
    ...row,
    batchId: typeof row.batchId === 'string' && row.batchId.length > 0 ? row.batchId : fallbackBatchId,
    withdrawn: row.withdrawn === true,
    withdrawnAt: typeof row.withdrawnAt === 'number' ? row.withdrawnAt : null,
  };
}

export function normalizeLocalData(data: Partial<LocalData>, fallbackBatchId: string): LocalData {
  const result = {} as LocalData;
  for (const table of TABLE_NAMES) {
    const rows = Array.isArray(data[table]) ? (data[table] as SyncRow[]) : [];
    result[table] = rows.map((row) => normalizeSyncRow(row, fallbackBatchId));
  }
  return result;
}

export function isWithdrawn(row: SyncRow | undefined): boolean {
  return row?.withdrawn === true;
}

/** 读取行上的任意业务字段（实体类型不同，按需收敛） */
export function fieldOf(row: SyncRow, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

/** 业务字段是否相等（剔除同步字段与时间戳后稳定序列化比较） */
const NON_BUSINESS_KEYS = new Set(['batchId', 'withdrawn', 'withdrawnAt', 'createdAt', 'updatedAt']);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = stableValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function sameBusinessFields(a: SyncRow, b: SyncRow): boolean {
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)].filter((key) => !NON_BUSINESS_KEYS.has(key)));
  for (const key of keys) {
    if (JSON.stringify(stableValue(ra[key])) !== JSON.stringify(stableValue(rb[key]))) return false;
  }
  return true;
}

/* ------------------------------ 批次 / 机器身份 ------------------------------ */

export const LS_KEYS_SYNC = {
  machineId: 'gbsealcarve:machine-id',
  machineName: 'gbsealcarve:machine-name',
  dataRev: 'gbsealcarve:data-rev',
  lastMergeAt: 'gbsealcarve:last-merge-at',
} as const;

export interface MachineIdentity {
  machineId: string;
  machineName: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

/** 读取本机身份（首次随机生成，存 localStorage） */
export function getMachineIdentity(): MachineIdentity {
  let machineId = '';
  let machineName = '';
  try {
    machineId = localStorage.getItem(LS_KEYS_SYNC.machineId) ?? '';
    machineName = localStorage.getItem(LS_KEYS_SYNC.machineName) ?? '';
  } catch {
    /* 隐私模式下回落内存 */
  }
  if (!machineId) {
    machineId = `dev_${Date.now().toString(36)}${randomSuffix()}`;
    try {
      localStorage.setItem(LS_KEYS_SYNC.machineId, machineId);
    } catch {
      /* ignore */
    }
  }
  if (!machineName) {
    machineName = `评审机-${randomSuffix()}`;
    try {
      localStorage.setItem(LS_KEYS_SYNC.machineName, machineName);
    } catch {
      /* ignore */
    }
  }
  return { machineId, machineName };
}

export function setMachineName(name: string): void {
  try {
    localStorage.setItem(LS_KEYS_SYNC.machineName, name);
  } catch {
    /* ignore */
  }
}

/** 生成批次 id：机器 + 开批日期时间 */
export function createBatchId(identity: MachineIdentity, startedAt: number = Date.now()): string {
  const d = new Date(startedAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `batch_${identity.machineId.replace(/^dev_/, '')}_${date}_${randomSuffix()}`;
}

export interface ActiveBatch {
  id: string;
  machineId: string;
  machineName: string;
  startedAt: number;
  label: string;
}

/* ------------------------------ 交接包 ------------------------------ */

export interface BatchBases {
  /** 行 id → 开批时该行的基线值（仅携带被改动行以控制体积） */
  [id: string]: SyncRow;
}

export interface HandoffPackage {
  app: typeof DB_NAME;
  kind: 'handoff';
  schemaVersion: number;
  batchId: string;
  machineId: string;
  machineName: string;
  startedAt: number;
  packedAt: string;
  label: string;
  /** 本批改动行（含撤回行，withdrawn=true） */
  changes: LocalData;
  /** 改动行在基线中的旧值 */
  bases: BatchBases;
}

/** 打包前校验交接包，返回错误文案（空串表示通过） */
export function validateHandoff(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const pkg = input as Partial<HandoffPackage>;
  if (pkg.app !== DB_NAME) return `交接包不属于本项目（app=${String(pkg.app)}）`;
  if (pkg.kind !== 'handoff') return '该文件是整库备份，不是离线交接包（请使用「离线交接」页生成）';
  if (typeof pkg.schemaVersion !== 'number') return '交接包缺少结构版本号';
  if (pkg.schemaVersion > HANDOFF_SCHEMA_VERSION)
    return `交接包来自更新版本（v${pkg.schemaVersion}），请先升级本机应用再导入`;
  if (!pkg.batchId) return '交接包缺少批次编号';
  for (const table of TABLE_NAMES) {
    if (!Array.isArray(pkg.changes?.[table])) return `交接包缺少 ${table} 集合`;
  }
  return '';
}

/* ------------------------------ 三方合并 ------------------------------ */

function findById(rows: SyncRow[], id: string): SyncRow | undefined {
  return rows.find((row) => row.id === id);
}

function defaultConflictResolution(local: SyncRow, incoming: SyncRow): ConflictResolution {
  return (incoming.updatedAt ?? 0) > (local.updatedAt ?? 0) ? 'incoming' : 'local';
}

function conflictReason(local: SyncRow, incoming: SyncRow, base: SyncRow | undefined): ConflictReason {
  if (isWithdrawn(incoming)) return 'local-modified-remote-withdrawn';
  if (isWithdrawn(local)) return 'local-withdrawn-remote-modified';
  void base;
  return 'both-modified';
}

/**
 * 单表（stone/design/catalog/impression 初分）三方分类。
 * carves 的特殊合并在 buildMergePlan 内单独处理。
 */
function classifyTable(
  table: TableName,
  localRows: SyncRow[],
  incomingRows: SyncRow[],
  bases: BatchBases,
  plan: MergePlan,
): void {
  for (const incomingRaw of incomingRows) {
    const incoming = normalizeSyncRow(incomingRaw, '');
    const local = findById(localRows, incoming.id);
    const base = bases[incoming.id] !== undefined ? normalizeSyncRow(bases[incoming.id] as SyncRow, '') : undefined;
    const item: MergeItem = { table, id: incoming.id, kind: 'skip', incoming, local, base };

    if (!local) {
      // 本机没有：新增（对方撤回了一条本机也没有的行则忽略）
      if (isWithdrawn(incoming)) {
        item.kind = 'skip';
        plan.skips.push(item);
      } else {
        item.kind = 'add';
        plan.adds.push(item);
        plan.items.push(item);
      }
      continue;
    }

    const localChangedFromBase = base ? !sameBusinessFields(local, base) : !sameBusinessFields(local, incoming);
    const incomingChangedFromBase = base ? !sameBusinessFields(incoming, base) : false;

    if (isWithdrawn(incoming)) {
      if ((base && sameBusinessFields(local, base)) || (!base && isWithdrawn(local))) {
        // 本机未动 → 接受撤回
        item.kind = 'withdraw';
        item.withdrawnAt = incoming.withdrawnAt;
        plan.withdraws.push(item);
        plan.items.push(item);
      } else {
        // 本机已改 → 冲突（撤回 vs 修改），默认保留本机
        const conflict: ConflictItem = {
          table,
          id: incoming.id,
          reason: 'local-modified-remote-withdrawn',
          local,
          incoming,
          base,
          resolution: 'local',
        };
        item.kind = 'conflict';
        plan.conflicts.push(conflict);
        plan.items.push(item);
      }
      continue;
    }

    if (sameBusinessFields(local, incoming)) {
      item.kind = 'skip';
      plan.skips.push(item);
      continue;
    }

    if (base) {
      if (!incomingChangedFromBase) {
        // 对方未改（理论上不该进包）→ 跳过
        item.kind = 'skip';
        plan.skips.push(item);
        continue;
      }
      if (!localChangedFromBase) {
        // 仅对方改 → 接受修改
        item.kind = 'update';
        plan.updates.push(item);
        plan.items.push(item);
        continue;
      }
    } else {
      // 无基线（旧包/异常）：本机与对方不同且都存在，视为双方修改
    }

    // 双方都改 → 冲突；印稿/印谱条目默认按更新时间自动建议，印石必须人工裁决
    const reason = conflictReason(local, incoming, base);
    const conflict: ConflictItem = {
      table,
      id: incoming.id,
      reason,
      local,
      incoming,
      base,
      resolution: defaultConflictResolution(local, incoming),
    };
    item.kind = 'conflict';
    plan.conflicts.push(conflict);
    plan.items.push(item);
  }
}

/** 判断某印稿的工序是否两边都改过：任一侧相对基线（或包内对方新增）有差异即算 */
function carveDesignTouched(
  designId: string,
  localRows: SyncRow[],
  incomingRows: SyncRow[],
  bases: BatchBases,
): { localTouched: boolean; incomingTouched: boolean } {
  const ids = new Set<string>();
  localRows.filter((r) => fieldOf(r, 'designId') === designId).forEach((r) => ids.add(r.id));
  incomingRows.filter((r) => fieldOf(r, 'designId') === designId).forEach((r) => ids.add(r.id));
  let localTouched = false;
  let incomingTouched = false;
  for (const id of ids) {
    const local = findById(localRows, id);
    const incoming = findById(incomingRows, id);
    const base = bases[id];
    if (local && incoming) {
      if (base) {
        if (!sameBusinessFields(local, base)) localTouched = true;
        if (!sameBusinessFields(incoming, base)) incomingTouched = true;
      } else {
        localTouched = true;
        incomingTouched = true;
      }
    } else if (local && base) {
      if (!sameBusinessFields(local, base) || local.withdrawn !== base.withdrawn) localTouched = true;
    } else if (incoming) {
      // 仅对方拥有该 id：
      // - 无基线 → 对方新增，只有本机也有该稿其它工序改动才算双改
      // - 基线存在（本机删/撤了该行）→ 本机被动改动，同时对方若改过算双改
      if (!base) {
        if (localRows.some((r) => fieldOf(r, 'designId') === designId)) incomingTouched = true;
      } else {
        incomingTouched = true;
        localTouched = true;
      }
    }
  }
  // 只有本机的工序被删/撤（对方包没有该 id，但基线有）也算本机改动
  for (const id of Object.keys(bases)) {
    const baseRow = bases[id];
    if (fieldOf(baseRow, 'designId') !== designId) continue;
    const local = findById(localRows, id);
    const incoming = findById(incomingRows, id);
    if (local && incoming === undefined) {
      if (!sameBusinessFields(local, baseRow) || local.withdrawn !== baseRow.withdrawn) localTouched = true;
    }
  }
  return { localTouched, incomingTouched };
}

/** 工序合并：保留两边记录，按刀法时长升序重排（同长按创建时间），序号重编 */
export function mergeCarveSteps(localRows: Carve[], incomingRows: Carve[]): CarveMergeGroup {
  const byId = new Map<string, Carve>();
  const remappedIds: Array<{ oldId: string; newId: string }> = [];
  const orderedSources: Carve[] = [];

  // 以本机为先（本机 id 稳定），对方同 id 工序复制为新行，避免覆盖任何一方记录
  for (const row of localRows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
      orderedSources.push(row);
    }
  }
  for (const row of incomingRows) {
    if (byId.has(row.id)) {
      const candidate = `carve_${row.id.replace(/^carve_/, '')}_m`;
      const newId = byId.has(candidate) ? `${candidate}_${Math.random().toString(36).slice(2, 6)}` : candidate;
      const copy: Carve = { ...row, id: newId };
      byId.set(newId, copy);
      remappedIds.push({ oldId: row.id, newId });
      orderedSources.push(copy);
    } else {
      byId.set(row.id, row);
      orderedSources.push(row);
    }
  }

  const merged = [...orderedSources]
    .sort((a, b) => a.minutes - b.minutes || (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id))
    .map((row, index) => ({ ...row, seq: index + 1 }));

  return {
    designId: localRows[0]?.designId ?? incomingRows[0]?.designId ?? '',
    merged,
    remappedIds,
  };
}

/** 处理 carves：双改印稿走工序合并，其余走通用分类 */
function classifyCarves(
  localRows: SyncRow[],
  incomingRows: SyncRow[],
  bases: BatchBases,
  plan: MergePlan,
): void {
  const touchedDesignIds = new Set<string>();
  incomingRows.forEach((row) => {
    const designId = fieldOf(row, 'designId');
    if (typeof designId === 'string') touchedDesignIds.add(designId);
  });

  const mergedDesignIds = new Set<string>();
  for (const designId of touchedDesignIds) {
    const { localTouched, incomingTouched } = carveDesignTouched(designId, localRows, incomingRows, bases);
    if (!localTouched || !incomingTouched) continue;
    mergedDesignIds.add(designId);

    const localCarves = localRows
      .filter((r) => fieldOf(r, 'designId') === designId && !isWithdrawn(r))
      .map((r) => r as unknown as Carve);
    const incomingCarves = incomingRows
      .filter((r) => fieldOf(r, 'designId') === designId && !isWithdrawn(r))
      .map((r) => normalizeSyncRow(r, '') as unknown as Carve);
    const group = mergeCarveSteps(localCarves, incomingCarves);
    plan.carveGroups.push(group);

    // 该印稿的包内工序不再逐条分类，统一由工序合并组生效（这里仅留档跳过）
    for (const row of incomingCarves) {
      const item: MergeItem = {
        table: 'carves',
        id: row.id,
        kind: 'skip',
        incoming: row,
        local: findById(localRows, row.id),
        base: bases[row.id],
      };
      plan.skips.push(item);
    }
  }

  const restIncoming = incomingRows.filter((row) => !mergedDesignIds.has(fieldOf(row, 'designId') as string));
  classifyTable('carves', localRows, restIncoming, bases, plan);
}

/** 钤印重复识别：同稿 + 同钤印日期 + 同纸张（再加印泥），评级高者胜，同级更新晚者胜 */
export function pickImpressionDuplicates(localRows: Impression[], incomingRows: Impression[]): ImpressionDupGroup[] {
  const groups = new Map<string, { designId: string; stampedAt: string; paperType: string; rows: Impression[] }>();
  const keyOf = (row: Impression): string => `${row.designId}|${row.stampedAt}|${row.paperType}|${row.inkBrand}`;
  const all = [...localRows, ...incomingRows];
  for (const row of all) {
    const key = keyOf(row);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else {
      groups.set(key, { designId: row.designId, stampedAt: row.stampedAt, paperType: row.paperType, rows: [row] });
    }
  }
  const result: ImpressionDupGroup[] = [];
  for (const group of groups.values()) {
    // 仅当组内同时存在本机与对方记录时才算「跨机重复按压」
    const hasLocal = group.rows.some((row) => localRows.some((l) => l.id === row.id));
    const hasIncoming = group.rows.some((row) => incomingRows.some((i) => i.id === row.id));
    if (group.rows.length < 2 || !hasLocal || !hasIncoming) continue;
    const sorted = [...group.rows].sort(
      (a, b) =>
        (GRADE_WEIGHT_VALUE as Record<Grade, number>)[b.grade] -
          (GRADE_WEIGHT_VALUE as Record<Grade, number>)[a.grade] ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
        b.id.localeCompare(a.id),
    );
    const [winner, ...losers] = sorted as [Impression, ...Impression[]];
    result.push({ designId: group.designId, stampedAt: group.stampedAt, paperType: group.paperType, winner, losers });
  }
  return result;
}

function classifyImpressions(
  localRows: SyncRow[],
  incomingRows: SyncRow[],
  bases: BatchBases,
  plan: MergePlan,
): void {
  // 先做通用分类（钤印的双改也按 LWW 自动建议，不强制裁决——重复识别另行处理）
  classifyTable('impressions', localRows, incomingRows, bases, plan);

  const activeLocal = localRows.filter((r) => !isWithdrawn(r)).map((r) => r as unknown as Impression);
  const activeIncoming = incomingRows
    .filter((r) => !isWithdrawn(r))
    .map((r) => normalizeSyncRow(r, '') as unknown as Impression);
  plan.impressionDups = pickImpressionDuplicates(activeLocal, activeIncoming);

  // 落选的对方新增/更新若本应写入，改为撤回去重；本机落选行在生效时撤回
  const loserIds = new Set(plan.impressionDups.flatMap((g) => g.losers.map((r) => r.id)));
  for (const item of plan.items) {
    if (item.table !== 'impressions') continue;
    if (loserIds.has(item.id)) {
      item.kind = 'skip';
      const bucket = plan.adds.includes(item)
        ? plan.adds
        : plan.updates.includes(item)
          ? plan.updates
          : plan.withdraws.includes(item)
            ? plan.withdraws
            : null;
      if (bucket) {
        const index = bucket.indexOf(item);
        if (index >= 0) bucket.splice(index, 1);
      }
      if (!plan.skips.includes(item)) plan.skips.push(item);
    }
  }
  const conflictIds = new Set(plan.conflicts.map((c) => c.id));
  for (const id of loserIds) if (!conflictIds.has(id)) void 0;
}

/**
 * 构建合并预览（不做任何写入）：
 * 分类新增 / 修改 / 撤回 / 冲突，附工序双改合并组与钤印重复组。
 */
export function buildMergePlan(pkg: HandoffPackage, localRaw: LocalData): MergePlan {
  const local = normalizeLocalData(localRaw, LEGACY_BATCH_ID);
  const incoming = normalizeLocalData(pkg.changes, pkg.batchId);
  const bases: BatchBases = {};
  for (const [id, row] of Object.entries(pkg.bases ?? {})) {
    bases[id] = normalizeSyncRow(row as SyncRow, LEGACY_BATCH_ID);
  }

  const plan: MergePlan = {
    items: [],
    conflicts: [],
    carveGroups: [],
    impressionDups: [],
    adds: [],
    updates: [],
    withdraws: [],
    skips: [],
    local,
  };

  classifyTable('stones', local.stones, incoming.stones, bases, plan);
  classifyTable('designs', local.designs, incoming.designs, bases, plan);
  classifyCarves(local.carves, incoming.carves, bases, plan);
  classifyImpressions(local.impressions, incoming.impressions, bases, plan);
  classifyTable('catalogs', local.catalogs, incoming.catalogs, bases, plan);

  return plan;
}

/** 未裁决的印石冲突数（印石信息冲突必须逐项裁决后才能生效） */
export function unresolvedStoneConflicts(plan: MergePlan, resolutions: Record<string, ConflictResolution>): number {
  return plan.conflicts.filter((c) => c.table === 'stones' && !(c.id in resolutions)).length;
}

/** 交接包是否已在本机应用过（同一批次不重复合并） */
export function isBatchAlreadyApplied(appliedBatchIds: string[], pkg: HandoffPackage): boolean {
  return appliedBatchIds.includes(pkg.batchId);
}

/** 应用合并计划所需的最终写入操作（h handoff.ts 在单个事务内执行） */
export interface AppliedResolution {
  id: string;
  resolution: ConflictResolution;
}

export interface MergeOperation {
  puts: Array<{ table: TableName; row: SyncRow }>;
  /** 撤回（软删除） */
  withdraws: Array<{ table: TableName; id: string; withdrawnAt: number | null }>;
  /** 工序双改：整稿合并结果（按刀法时长重排后整体替换该稿未撤回工序） */
  carveGroups: CarveMergeGroup[];
  /** 钤印重复组（撤回落选行） */
  impressionDups: ImpressionDupGroup[];
}

/**
 * 根据裁决结果生成最终操作。
 * 印石冲突若未给裁决，抛错（界面应阻止确认）。
 */
export function resolveMergeOperations(
  plan: MergePlan,
  resolutions: Record<string, ConflictResolution>,
  activeBatchId: string,
): MergeOperation {
  const puts: MergeOperation['puts'] = [];
  const withdraws: MergeOperation['withdraws'] = [];
  const now = Date.now();

  const stampIncoming = (row: SyncRow): SyncRow =>
    normalizeSyncRow({ ...row, batchId: activeBatchId, withdrawn: false, withdrawnAt: null }, activeBatchId);

  for (const item of plan.adds) {
    if (!item.incoming) continue;
    puts.push({ table: item.table, row: stampIncoming(item.incoming) });
  }
  for (const item of plan.updates) {
    if (!item.incoming) continue;
    const row = stampIncoming(item.incoming);
    // 保留本机创建时间
    if (item.local && typeof item.local.createdAt === 'number') row.createdAt = item.local.createdAt;
    puts.push({ table: item.table, row });
  }
  for (const item of plan.withdraws) {
    withdraws.push({ table: item.table, id: item.id, withdrawnAt: item.incoming?.withdrawnAt ?? now });
  }

  // 冲突裁决
  for (const conflict of plan.conflicts) {
    const resolution = resolutions[conflict.id] ?? conflict.resolution;
    if (conflict.table === 'stones' && !(conflict.id in resolutions)) {
      throw new Error('尚有印石信息冲突未裁决，请逐项选择后再确认生效');
    }
    if (resolution === 'local') {
      // 保留本机：对方撤回 / 修改均不生效（若本机此前已撤回而对方改过，维持撤回）
      if (isWithdrawn(conflict.local)) {
        withdraws.push({ table: conflict.table, id: conflict.id, withdrawnAt: conflict.local.withdrawnAt ?? now });
      }
      continue;
    }
    // 采用对方
    if (isWithdrawn(conflict.incoming)) {
      withdraws.push({ table: conflict.table, id: conflict.id, withdrawnAt: conflict.incoming.withdrawnAt ?? now });
    } else {
      const row = stampIncoming(conflict.incoming);
      if (typeof conflict.local.createdAt === 'number') row.createdAt = conflict.local.createdAt;
      puts.push({ table: conflict.table, row });
    }
  }

  return { puts, withdraws, carveGroups: plan.carveGroups, impressionDups: plan.impressionDups };
}

/** 同石采用稿唯一：合并后修正，每石仅保留更新时间最晚的 adopted 稿 */
export function adoptedFixups(designRows: Array<Design & SyncRow>): Array<Design & SyncRow> {
  const byStone = new Map<string, Array<Design & SyncRow>>();
  for (const row of designRows) {
    if (row.withdrawn || !row.adopted) continue;
    const list = byStone.get(row.stoneId) ?? [];
    list.push(row);
    byStone.set(row.stoneId, list);
  }
  const demote: Array<Design & SyncRow> = [];
  for (const list of byStone.values()) {
    if (list.length <= 1) continue;
    const sorted = [...list].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sorted.slice(1).forEach((row) => demote.push({ ...row, adopted: false, updatedAt: Date.now() }));
  }
  return demote;
}

/** 预估活动批次改动（导出前在界面列出本批新增/修改/撤回） */
export interface BatchChangePreview {
  table: TableName;
  id: string;
  kind: ChangeKind;
}

export function previewBatchChanges(active: ActiveBatch, current: LocalData, bases: BatchBases): BatchChangePreview[] {
  const result: BatchChangePreview[] = [];
  for (const table of TABLE_NAMES) {
    for (const row of current[table]) {
      const belongsToBatch = row.batchId === active.id || (row.updatedAt ?? 0) >= active.startedAt;
      if (!belongsToBatch) continue;
      const base = bases[row.id];
      if (isWithdrawn(row)) {
        if (base && !isWithdrawn(base)) result.push({ table, id: row.id, kind: 'withdraw' });
        // 开批后新建又撤回的行不导出
        continue;
      }
      if (!base) {
        result.push({ table, id: row.id, kind: 'add' });
      } else if (!sameBusinessFields(row, base)) {
        result.push({ table, id: row.id, kind: 'update' });
      }
    }
  }
  return result;
}

/** 收集批次改动行（导出交接包内容） */
export function collectBatchChanges(active: ActiveBatch, current: LocalData): LocalData {
  const result = {} as LocalData;
  for (const table of TABLE_NAMES) {
    result[table] = current[table].filter(
      (row) => row.batchId === active.id || (row.updatedAt ?? 0) >= active.startedAt,
    );
  }
  return result;
}
