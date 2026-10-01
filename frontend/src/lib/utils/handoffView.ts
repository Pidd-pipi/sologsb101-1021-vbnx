/**
 * 离线交接界面辅助：表名/行标题/字段差异的可读化展示。
 * 纯函数，供 /handoff 页与审核对话框复用。
 */
import {
  STONE_TYPE_LABEL,
  KNOB_STYLE_LABEL,
  STONE_STATE_LABEL,
  type Stone,
} from '$lib/types/stone';
import {
  DESIGN_STYLE_LABEL,
  BORDER_STYLE_LABEL,
  type Design,
} from '$lib/types/design';
import {
  KNIFE_METHOD_LABEL,
  CARVE_STATE_LABEL,
  type Carve,
} from '$lib/types/carve';
import {
  GRADE_LABEL,
  PAPER_KIND_LABEL,
  PRESSURE_LABEL,
  type Impression,
} from '$lib/types/impression';
import { INCLUDED_LABEL, type Catalog } from '$lib/types/catalog';
import type { LocalData, SyncRow, TableName } from './sync';

export const TABLE_LABEL: Record<TableName, string> = {
  stones: '印石',
  designs: '印稿',
  carves: '刻制工序',
  impressions: '钤印',
  catalogs: '印谱条目',
};

/** 业务字段的中文标签（用于冲突字段对比） */
export const FIELD_LABELS: Record<string, string> = {
  name: '印石名',
  stoneType: '石种',
  sizeMm: '尺寸',
  knobStyle: '钮式',
  purchaseDate: '购入日期',
  state: '状态',
  sealText: '印文',
  annotation: '释文',
  style: '朱白文',
  borderStyle: '边框',
  layoutNote: '章法备注',
  adopted: '采用稿',
  seq: '序号',
  knifeMethod: '刀法',
  minutes: '时长(分)',
  operator: '执刀人',
  carveState: '工序状态',
  inkBrand: '印泥',
  paperType: '纸张',
  pressure: '压力',
  grade: '评级',
  stampedAt: '钤印日期',
  note: '备注',
  orderNo: '排序号',
  included: '收录状态',
  stoneId: '所属印石',
  designId: '所属印稿',
};

const ENUM_VALUE_LABEL: Record<string, Record<string, string>> = {
  stoneType: STONE_TYPE_LABEL,
  knobStyle: KNOB_STYLE_LABEL,
  state: STONE_STATE_LABEL,
  style: DESIGN_STYLE_LABEL,
  borderStyle: BORDER_STYLE_LABEL,
  knifeMethod: KNIFE_METHOD_LABEL,
  carveState: CARVE_STATE_LABEL,
  pressure: PRESSURE_LABEL,
  grade: GRADE_LABEL,
  paperType: PAPER_KIND_LABEL,
  included: INCLUDED_LABEL,
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function fieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'adopted') return value === true ? '采用' : '不采用';
  const enumMap = ENUM_VALUE_LABEL[field];
  if (enumMap && typeof value === 'string') return enumMap[value] ?? String(value);
  return String(value);
}

function asStone(row: SyncRow): Stone {
  return row as unknown as Stone;
}
function asDesign(row: SyncRow): Design {
  return row as unknown as Design;
}
function asCarve(row: SyncRow): Carve {
  return row as unknown as Carve;
}
function asImpression(row: SyncRow): Impression {
  return row as unknown as Impression;
}
function asCatalog(row: SyncRow): Catalog {
  return row as unknown as Catalog;
}

/** 行的主标题（印石名 / 印文 / 刀法 / 钤印日期 / 排序号） */
export function rowTitle(table: TableName, row: SyncRow | undefined): string {
  if (!row) return '（记录不存在）';
  if (table === 'stones') return asStone(row).name;
  if (table === 'designs') return `${asDesign(row).sealText}${asDesign(row).annotation ? `（${asDesign(row).annotation}）` : ''}`;
  if (table === 'carves') {
    const carve = asCarve(row);
    return `${carve.seq}. ${KNIFE_METHOD_LABEL[carve.knifeMethod]} · ${carve.minutes}分${carve.operator ? ` · ${carve.operator}` : ''}`;
  }
  if (table === 'impressions') {
    const impression = asImpression(row);
    return `${impression.stampedAt} · ${PAPER_KIND_LABEL[impression.paperType]} · ${GRADE_LABEL[impression.grade]}（${impression.inkBrand}）`;
  }
  return `印谱第 ${asCatalog(row).orderNo} 位 · ${INCLUDED_LABEL[asCatalog(row).included]}`;
}

export interface RowContext {
  stones: Map<string, Stone>;
  designs: Map<string, Design>;
}

export function buildRowContext(local: LocalData): RowContext {
  return {
    stones: new Map(local.stones.map((row) => [row.id, asStone(row)])),
    designs: new Map(local.designs.map((row) => [row.id, asDesign(row)])),
  };
}

/** 工序/钤印/印谱条目附带的印文上下文 */
export function designTextOf(context: RowContext, designId: unknown): string {
  const design = context.designs.get(String(designId));
  return design ? `${design.sealText}` : '（印稿已删除）';
}

export function stoneTextOf(context: RowContext, stoneId: unknown): string {
  const stone = context.stones.get(String(stoneId));
  return stone?.name ?? '（印石已删除）';
}

export interface FieldDiff {
  field: string;
  label: string;
  local: string;
  incoming: string;
}

const HIDDEN_DIFF_FIELDS = new Set(['id', 'batchId', 'withdrawn', 'withdrawnAt', 'createdAt', 'updatedAt']);

/** 计算两条记录的字段差异（供冲突裁决对比） */
export function diffFields(table: TableName, local: SyncRow, incoming: SyncRow): FieldDiff[] {
  void table;
  const localRecord = local as unknown as Record<string, unknown>;
  const incomingRecord = incoming as unknown as Record<string, unknown>;
  const keys = new Set(
    [...Object.keys(localRecord), ...Object.keys(incomingRecord)].filter((key) => !HIDDEN_DIFF_FIELDS.has(key)),
  );
  const diffs: FieldDiff[] = [];
  for (const field of keys) {
    const localValue = fieldValue(field, localRecord[field]);
    const incomingValue = fieldValue(field, incomingRecord[field]);
    if (localValue !== incomingValue) {
      diffs.push({ field, label: fieldLabel(field), local: localValue, incoming: incomingValue });
    }
  }
  return diffs;
}

/** 撤回状态展示 */
export function withdrawnText(row: SyncRow | undefined): string {
  return row?.withdrawn === true ? '已撤回' : '在册';
}

/** 时长格式化 */
export function minutesLabel(minutes: unknown): string {
  return typeof minutes === 'number' ? `${minutes} 分钟` : String(minutes ?? '—');
}

export function carveStateText(row: SyncRow): string {
  const carve = asCarve(row);
  return CARVE_STATE_LABEL[carve.state];
}
