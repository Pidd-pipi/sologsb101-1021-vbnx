/**
 * 离线交接（Handooff）数据模型
 * 各机一批：导出交接包 → 回社合并，先预览新增 / 修改 / 撤回 / 冲突，确认后一起生效。
 */
import type { Stone } from './stone';
import type { Design } from './design';
import type { Carve } from './carve';
import type { Impression } from './impression';
import type { Catalog } from './catalog';

/** 交接包文件标识（与全量备份区分） */
export const HANDOFF_APP = 'gbsealcarve';
export const HANDOFF_KIND = 'handoff-batch';

/** 数据结构版本：v3 起所有记录带 batchId / withdrawn 标记 */
export const HANDOFF_SCHEMA_VERSION = 3;

/** 批次元信息（随交接包一起导出） */
export interface BatchMeta {
  /** 批次 id */
  id: string;
  /** 批次号（人类可读，如 20261001-1430） */
  no: string;
  /** 机器 id（每浏览器稳定，存 localStorage） */
  machineId: string;
  /** 机器名（用户可改，如「1号机」） */
  machineName: string;
  /** 执刀人 / 导出人 */
  operator: string;
  /** 导出时间 ISO */
  exportedAt: string;
  /** 备注 */
  note: string;
}

/** 导入后的批次留档（batches 表一行） */
export interface BatchRecord extends BatchMeta {
  /** 导入本机时间 */
  importedAt: string;
  /** 本批记录数（五表合计） */
  recordCount: number;
}

/** 五张业务表名 */
export type TableName = 'stones' | 'designs' | 'carves' | 'impressions' | 'catalogs';

export const TABLE_LABEL: Record<TableName, string> = {
  stones: '印石',
  designs: '印稿',
  carves: '工序',
  impressions: '钤印',
  catalogs: '印谱条目',
};

/** 任意带交接标记的业务记录 */
export interface HandoffRecord {
  id: string;
  /** 最近一次触碰它的批次 id（本地编辑用机器 id，迁移用 MIGRATION_BATCH_ID） */
  batchId?: string;
  /** 软删除标记：撤回 */
  withdrawn?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 交接包：全量当前数据 + 批次元信息 + 基线快照（三区合并用） */
export interface HandoffPackage {
  app: typeof HANDOFF_APP;
  kind: typeof HANDOFF_KIND;
  schemaVersion: number;
  batch: BatchMeta;
  /** 基线快照：本机上次同步时的五表数据（三区合并的「共同祖先」） */
  base: Record<TableName, HandoffRecord[]>;
  stones: Stone[];
  designs: Design[];
  carves: Carve[];
  impressions: Impression[];
  catalogs: Catalog[];
}

/** 单字段冲突（印石 / 印稿信息裁决用） */
export interface FieldConflict {
  table: TableName;
  recordId: string;
  field: string;
  fieldLabel: string;
  localValue: unknown;
  remoteValue: unknown;
  /** 裁决结果：local 或 remote，默认 remote（新导入优先） */
  choice: 'local' | 'remote';
}

/** 一条变更（预览中的最小单元） */
export interface MergeChange {
  /** 变更类别 */
  kind: 'add' | 'modify' | 'withdraw' | 'conflict';
  table: TableName;
  recordId: string;
  /** 展示标题（如印石名 / 印文） */
  title: string;
  /** 所属印石名（工序 / 钤印用） */
  stoneName?: string;
  /** 冲突时的字段级裁决（仅 stones / designs） */
  fieldConflicts?: FieldConflict[];
  /** 修改类变更的字段差异摘要 */
  changedFields?: string[];
  /** 撤回时的撤回时间 */
  withdrawnAt?: number;
}

/** 合并预览 */
export interface MergePreview {
  /** 交接包批次信息 */
  batch: BatchMeta;
  /** 各类变更 */
  changes: MergeChange[];
  /** 新增数 */
  addCount: number;
  /** 修改数 */
  modifyCount: number;
  /** 撤回数 */
  withdrawCount: number;
  /** 冲突数 */
  conflictCount: number;
  /** 包内记录总数 */
  recordCount: number;
  /** 基线是否可用（无基线时退化为时间戳合并） */
  hasBase: boolean;
}

/** 合并结果（applyMerge 返回） */
export interface MergeResult {
  appliedAt: string;
  batch: BatchMeta;
  addCount: number;
  modifyCount: number;
  withdrawCount: number;
  conflictCount: number;
  /** 重算后的印谱条目数 */
  catalogCount: number;
}
