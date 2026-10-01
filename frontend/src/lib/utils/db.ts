/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑（v1 初版；v2 为 impressions 增加 grade 索引、
 *   为 catalogs 增加 orderNo 索引，并回填历史记录缺失字段）
 * - 五张业务表的增删改查与整库导入导出
 * - 首次打开自动播种三层互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Stone } from '$lib/types/stone';
import type { Design } from '$lib/types/design';
import type { Carve } from '$lib/types/carve';
import type { Impression } from '$lib/types/impression';
import type { Catalog } from '$lib/types/catalog';
import type { BatchRecord, TableName } from '$lib/types/batch';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gbsealcarve';

/** 当前数据结构版本号 */
export const DB_VERSION = 3;

/** v3 迁移批次 id：旧数据补批次标记时统一归入该批次 */
export const MIGRATION_BATCH_ID = 'migration-v3';

/** 本机批次 id：本地编辑（未导出）统一使用，配合机器 id 区分不同设备 */
export const LOCAL_BATCH_ID = 'local';

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gbsealcarve:db-version',
  lastBackupAt: 'gbsealcarve:last-backup-at',
  uiPrefs: 'gbsealcarve:ui-prefs',
  machineId: 'gbsealcarve:machine-id',
  baseSnapshot: 'gbsealcarve:base-snapshot',
  restorePoint: 'gbsealcarve:restore-point',
} as const;

/** 单表快照（基线 / 还原点用） */
export type TableSnapshot = unknown[];

export interface BaseSnapshot {
  exportedAt: string;
  stones: TableSnapshot;
  designs: TableSnapshot;
  carves: TableSnapshot;
  impressions: TableSnapshot;
  catalogs: TableSnapshot;
}

/** 还原点：导入失败或撤销时恢复到导入前 */
export interface RestorePoint {
  savedAt: string;
  reason: string;
  stones: TableSnapshot;
  designs: TableSnapshot;
  carves: TableSnapshot;
  impressions: TableSnapshot;
  catalogs: TableSnapshot;
}

/** 读取（或首次生成）本机稳定机器 id */
export function getMachineId(): string {
  try {
    const existing = localStorage.getItem(LS_KEYS.machineId);
    if (existing) return existing;
    const id = `machine_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(LS_KEYS.machineId, id);
    return id;
  } catch {
    return 'machine_unknown';
  }
}

export interface UiPrefs {
  lastStoneId: string | null;
  lastDesignId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastStoneId: null, lastDesignId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return {
      lastStoneId: typeof parsed.lastStoneId === 'string' ? parsed.lastStoneId : null,
      lastDesignId: typeof parsed.lastDesignId === 'string' ? parsed.lastDesignId : null,
    };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 隐私模式下忽略 */
  }
}

export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

/* ------------------------- 基线快照（三区合并用） ------------------------- */

const SNAPSHOT_SIZE_LIMIT = 4 * 1024 * 1024;

function readSnapshotKey<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeSnapshotKey(key: string, value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    if (text.length > SNAPSHOT_SIZE_LIMIT) return false;
    localStorage.setItem(key, text);
    return true;
  } catch {
    return false;
  }
}

/** 读取基线快照（本机上次同步点） */
export function readBaseSnapshot(): BaseSnapshot | null {
  return readSnapshotKey<BaseSnapshot>(LS_KEYS.baseSnapshot);
}

/** 写入基线快照（合并完成后调用）；数据过大时放弃，退化为时间戳合并 */
export function writeBaseSnapshot(snapshot: BaseSnapshot): boolean {
  return writeSnapshotKey(LS_KEYS.baseSnapshot, snapshot);
}

/** 保存还原点（导入前快照），导入失败或撤销时恢复 */
export function saveRestorePoint(point: RestorePoint): boolean {
  return writeSnapshotKey(LS_KEYS.restorePoint, point);
}

export function readRestorePoint(): RestorePoint | null {
  return readSnapshotKey<RestorePoint>(LS_KEYS.restorePoint);
}

export function clearRestorePoint(): void {
  try {
    localStorage.removeItem(LS_KEYS.restorePoint);
  } catch {
    /* ignore */
  }
}

/** 把当前五表全量（含撤回记录）序列化为快照对象 */
export async function captureSnapshot(): Promise<BaseSnapshot> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  return { exportedAt: new Date().toISOString(), stones, designs, carves, impressions, catalogs };
}

class SealCarveDatabase extends Dexie {
  stones!: Table<Stone, string>;
  designs!: Table<Design, string>;
  carves!: Table<Carve, string>;
  impressions!: Table<Impression, string>;
  catalogs!: Table<Catalog, string>;
  batches!: Table<BatchRecord, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      stones: 'id, name, stoneType, state, updatedAt',
      designs: 'id, stoneId, style, adopted, updatedAt',
      carves: 'id, designId, seq, knifeMethod, state, updatedAt',
      impressions: 'id, designId, grade, stampedAt, updatedAt',
      catalogs: 'id, stoneId, designId, orderNo, updatedAt',
    });

    // v2：补充检索索引并回填历史记录缺失字段
    this.version(2)
      .stores({
        stones: 'id, name, stoneType, knobStyle, state, purchaseDate, updatedAt',
        designs: 'id, stoneId, style, borderStyle, adopted, updatedAt',
        carves: 'id, designId, seq, knifeMethod, operator, state, updatedAt',
        impressions: 'id, designId, grade, paperType, stampedAt, updatedAt',
        catalogs: 'id, stoneId, designId, orderNo, included, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Impression>('impressions')
          .toCollection()
          .modify((impression) => {
            const legal = ['excellent', 'good', 'fair', 'waste'];
            if (!legal.includes(impression.grade)) impression.grade = 'good';
            if (typeof impression.note !== 'string') impression.note = '';
          });
        await tx
          .table<Design>('designs')
          .toCollection()
          .modify((design) => {
            if (typeof design.adopted !== 'boolean') design.adopted = false;
            if (!design.borderStyle) design.borderStyle = 'borrow';
          });
        await tx
          .table<Catalog>('catalogs')
          .toCollection()
          .modify((catalog) => {
            if (typeof catalog.orderNo !== 'number' || catalog.orderNo <= 0) catalog.orderNo = 1;
            if (!catalog.included) catalog.included = 'pending';
          });
      });

    // v3：所有业务记录补 batchId / withdrawn 标记；新增 batches 批次留档表
    this.version(DB_VERSION)
      .stores({
        stones: 'id, name, stoneType, knobStyle, state, purchaseDate, batchId, withdrawn, updatedAt',
        designs: 'id, stoneId, style, borderStyle, adopted, batchId, withdrawn, updatedAt',
        carves: 'id, designId, seq, knifeMethod, operator, state, batchId, withdrawn, updatedAt',
        impressions: 'id, designId, grade, paperType, stampedAt, batchId, withdrawn, updatedAt',
        catalogs: 'id, stoneId, designId, orderNo, included, batchId, withdrawn, updatedAt',
        batches: 'id, no, machineId, exportedAt, importedAt',
      })
      .upgrade(async (tx) => {
        const tables = ['stones', 'designs', 'carves', 'impressions', 'catalogs'];
        for (const table of tables) {
          await tx
            .table(table)
            .toCollection()
            .modify((record: Record<string, unknown>) => {
              if (typeof record.batchId !== 'string' || record.batchId.length === 0) {
                record.batchId = MIGRATION_BATCH_ID;
              }
              if (typeof record.withdrawn !== 'boolean') record.withdrawn = false;
            });
        }
      });
  }
}

export const db = new SealCarveDatabase();

/** 生成主键：短前缀 + 时间戳 + 随机串 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 本地新建记录补批次标记（未导出前统一记为 LOCAL_BATCH_ID） */
export function withLocalBatch<T extends object>(row: T): T & { batchId: string; withdrawn: boolean } {
  return { ...row, batchId: LOCAL_BATCH_ID, withdrawn: false };
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.stones.count()) === 0) {
    await seedDatabase();
  }
  // 迁移后首次打开：补批次 / 撤回标记（v3 upgrade 处理旧库；此处兜底新库播种数据）
  await backfillBatchMarkers();
  // 补齐基线快照（三区合并的共同祖先）
  if (!readBaseSnapshot()) {
    const snapshot = await captureSnapshot();
    writeBaseSnapshot(snapshot);
  }
}

/** 为缺少 batchId / withdrawn 的记录补默认标记（幂等） */
async function backfillBatchMarkers(): Promise<void> {
  const tables = ['stones', 'designs', 'carves', 'impressions', 'catalogs'] as const;
  for (const table of tables) {
    await db
      .table(table)
      .toCollection()
      .modify((record: Record<string, unknown>) => {
        if (typeof record.batchId !== 'string' || record.batchId.length === 0) {
          record.batchId = MIGRATION_BATCH_ID;
        }
        if (typeof record.withdrawn !== 'boolean') record.withdrawn = false;
      });
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Stone → Design →（Carve / Impression）＋ Stone → Catalog */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const day = 86400000;

  const stones: Stone[] = [
    {
      id: 'stone_01',
      name: '寿山黄芙蓉方章',
      stoneType: 'shoushan',
      sizeMm: '25×25×62',
      knobStyle: 'flat',
      purchaseDate: '2025-11-08',
      state: 'carved',
      createdAt: now - day * 90,
      updatedAt: now - day * 4,
    },
    {
      id: 'stone_02',
      name: '青田封门青素章',
      stoneType: 'qingtian',
      sizeMm: '28×28×70',
      knobStyle: 'bridge',
      purchaseDate: '2026-01-16',
      state: 'carving',
      createdAt: now - day * 52,
      updatedAt: now - day * 2,
    },
    {
      id: 'stone_03',
      name: '昌化鸡血石古兽钮',
      stoneType: 'changhua',
      sizeMm: '22×22×55',
      knobStyle: 'beast',
      purchaseDate: '2025-08-21',
      state: 'idle',
      createdAt: now - day * 160,
      updatedAt: now - day * 30,
    },
    {
      id: 'stone_04',
      name: '巴林冻薄意章',
      stoneType: 'balin',
      sizeMm: '20×30×58',
      knobStyle: 'thin',
      purchaseDate: '2026-02-02',
      state: 'carving',
      createdAt: now - day * 30,
      updatedAt: now - day,
    },
  ];

  const designs: Design[] = [
    { id: 'design_0101', stoneId: 'stone_01', sealText: '澄怀观道', annotation: '宗炳《画山水序》语，四字朱文', style: 'zhu', borderStyle: 'borrow', layoutNote: '四字均分，「观」字略收以让边', adopted: true, createdAt: now - day * 70, updatedAt: now - day * 40 },
    { id: 'design_0102', stoneId: 'stone_01', sealText: '澄怀', annotation: '取前稿二字，作小印', style: 'bai', borderStyle: 'none', layoutNote: '二字上下排布，留大片红', adopted: false, createdAt: now - day * 60, updatedAt: now - day * 55 },
    { id: 'design_0201', stoneId: 'stone_02', sealText: '日新其德', annotation: '《礼记·大学》语，白文', style: 'bai', borderStyle: 'double', layoutNote: '双边仿汉印，「德」字略长', adopted: true, createdAt: now - day * 40, updatedAt: now - day * 6 },
    { id: 'design_0301', stoneId: 'stone_03', sealText: '金石为开', annotation: '汉谚，朱文借边', style: 'zhu', borderStyle: 'borrow', layoutNote: '借边求满，四字紧凑', adopted: true, createdAt: now - day * 120, updatedAt: now - day * 100 },
    { id: 'design_0401', stoneId: 'stone_04', sealText: '清风徐来', annotation: '《赤壁赋》语，瓦当式', style: 'zhu', borderStyle: 'tile', layoutNote: '瓦当圆框，「来」字压缩', adopted: true, createdAt: now - day * 20, updatedAt: now - day * 2 },
  ];

  const carves: Carve[] = [
    { id: 'carve_010101', designId: 'design_0101', seq: 1, knifeMethod: 'chong', minutes: 40, operator: '顾墨', state: 'done', createdAt: now - day * 66, updatedAt: now - day * 64 },
    { id: 'carve_010102', designId: 'design_0101', seq: 2, knifeMethod: 'qie', minutes: 30, operator: '顾墨', state: 'done', createdAt: now - day * 64, updatedAt: now - day * 62 },
    { id: 'carve_010103', designId: 'design_0101', seq: 3, knifeMethod: 'trim', minutes: 15, operator: '顾墨', state: 'done', createdAt: now - day * 62, updatedAt: now - day * 40 },
    { id: 'carve_020101', designId: 'design_0201', seq: 1, knifeMethod: 'chong', minutes: 40, operator: '林砚', state: 'done', createdAt: now - day * 36, updatedAt: now - day * 34 },
    { id: 'carve_020102', designId: 'design_0201', seq: 2, knifeMethod: 'double', minutes: 25, operator: '林砚', state: 'doing', createdAt: now - day * 34, updatedAt: now - day * 3 },
    { id: 'carve_020103', designId: 'design_0201', seq: 3, knifeMethod: 'trim', minutes: 15, operator: '林砚', state: 'todo', createdAt: now - day * 34, updatedAt: now - day * 6 },
    { id: 'carve_030101', designId: 'design_0301', seq: 1, knifeMethod: 'chong', minutes: 45, operator: '顾墨', state: 'done', createdAt: now - day * 115, updatedAt: now - day * 112 },
    { id: 'carve_030102', designId: 'design_0301', seq: 2, knifeMethod: 'trim', minutes: 20, operator: '顾墨', state: 'done', createdAt: now - day * 112, updatedAt: now - day * 100 },
    { id: 'carve_040101', designId: 'design_0401', seq: 1, knifeMethod: 'qie', minutes: 30, operator: '林砚', state: 'doing', createdAt: now - day * 16, updatedAt: now - day * 2 },
  ];

  const impressions: Impression[] = [
    { id: 'impr_010101', designId: 'design_0101', inkBrand: '西泠印泥', paperType: 'lianshi', pressure: 'medium', grade: 'excellent', stampedAt: '2026-01-20', note: '采用稿效果，朱色匀净', createdAt: now - day * 60, updatedAt: now - day * 60 },
    { id: 'impr_010102', designId: 'design_0101', inkBrand: '漳州八宝', paperType: 'xuan', pressure: 'heavy', grade: 'fair', stampedAt: '2026-01-18', note: '压力偏重，边栏糊', createdAt: now - day * 62, updatedAt: now - day * 62 },
    { id: 'impr_020101', designId: 'design_0201', inkBrand: '苏州姜思序堂', paperType: 'luowen', pressure: 'light', grade: 'good', stampedAt: '2026-03-02', note: '', createdAt: now - day * 20, updatedAt: now - day * 20 },
    { id: 'impr_030101', designId: 'design_0301', inkBrand: '西泠印泥', paperType: 'lianshi', pressure: 'medium', grade: 'excellent', stampedAt: '2025-12-12', note: '旧作重钤，效果稳定', createdAt: now - day * 105, updatedAt: now - day * 105 },
    { id: 'impr_030102', designId: 'design_0301', inkBrand: '自制朱磦', paperType: 'lianshi', pressure: 'light', grade: 'waste', stampedAt: '2025-12-20', note: '印泥过干，效果不佳', createdAt: now - day * 100, updatedAt: now - day * 100 },
    { id: 'impr_040101', designId: 'design_0401', inkBrand: '西泠印泥', paperType: 'xuan', pressure: 'medium', grade: 'good', stampedAt: '2026-03-08', note: '试钤一版，待修边后再钤', createdAt: now - day * 2, updatedAt: now - day * 2 },
  ];

  const catalogs: Catalog[] = [
    { id: 'cata_0101', stoneId: 'stone_01', designId: 'design_0101', orderNo: 1, included: 'included', note: '印谱首方', createdAt: now - day * 50, updatedAt: now - day * 50 },
    { id: 'cata_0201', stoneId: 'stone_02', designId: 'design_0201', orderNo: 2, included: 'pending', note: '待修整完稿后收录', createdAt: now - day * 30, updatedAt: now - day * 6 },
    { id: 'cata_0301', stoneId: 'stone_03', designId: 'design_0301', orderNo: 3, included: 'included', note: '鸡血石代表方', createdAt: now - day * 95, updatedAt: now - day * 95 },
    { id: 'cata_0401', stoneId: 'stone_04', designId: 'design_0401', orderNo: 4, included: 'excluded', note: '此稿暂不收录，另拟新稿', createdAt: now - day * 10, updatedAt: now - day * 2 },
  ];

  await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs], async () => {
    await db.stones.bulkPut(stones);
    await db.designs.bulkPut(designs);
    await db.carves.bulkPut(carves);
    await db.impressions.bulkPut(impressions);
    await db.catalogs.bulkPut(catalogs);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface SealCarveSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  stones: Stone[];
  designs: Design[];
  carves: Carve[];
  impressions: Impression[];
  catalogs: Catalog[];
}

export async function exportSnapshot(): Promise<SealCarveSnapshot> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  const visible = <T extends { withdrawn?: boolean }>(rows: T[]): T[] => rows.filter((row) => !row.withdrawn);
  return {
    app: DB_NAME,
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    stones: visible(stones),
    designs: visible(designs),
    carves: visible(carves),
    impressions: visible(impressions),
    catalogs: visible(catalogs),
  };
}

/** 交接包导出：五表全量（含撤回记录，以便把删除操作传播到其他机器） */
export async function exportHandoffTables(): Promise<{
  stones: Stone[];
  designs: Design[];
  carves: Carve[];
  impressions: Impression[];
  catalogs: Catalog[];
}> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  return { stones, designs, carves, impressions, catalogs };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<SealCarveSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof SealCarveSnapshot> = ['stones', 'designs', 'carves', 'impressions', 'catalogs'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs], async () => {
    await Promise.all([
      db.stones.clear(),
      db.designs.clear(),
      db.carves.clear(),
      db.impressions.clear(),
      db.catalogs.clear(),
    ]);
  });
}

export async function importSnapshot(snapshot: SealCarveSnapshot): Promise<void> {
  await clearAllTables();
  await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs], async () => {
    await db.stones.bulkPut(snapshot.stones);
    await db.designs.bulkPut(snapshot.designs);
    await db.carves.bulkPut(snapshot.carves);
    await db.impressions.bulkPut(snapshot.impressions);
    await db.catalogs.bulkPut(snapshot.catalogs);
  });
}

export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.count(),
    db.designs.count(),
    db.carves.count(),
    db.impressions.count(),
    db.catalogs.count(),
  ]);
  return { stones, designs, carves, impressions, catalogs };
}

/** 级联撤回印石 → 印稿 → 工序 / 钤印 / 印谱条目（软删除，标记 withdrawn 以便交接传播） */
export async function removeStoneCascade(stoneId: string): Promise<void> {
  const now = Date.now();
  const designs = await db.designs.where('stoneId').equals(stoneId).toArray();
  const designIds = designs.map((row) => row.id);
  await db.transaction('rw', [db.stones, db.designs, db.carves, db.impressions, db.catalogs], async () => {
    if (designIds.length > 0) {
      const [carves, impressions, catalogs] = await Promise.all([
        db.carves.where('designId').anyOf(designIds).toArray(),
        db.impressions.where('designId').anyOf(designIds).toArray(),
        db.catalogs.where('designId').anyOf(designIds).toArray(),
      ]);
      await Promise.all([
        db.carves.bulkPut(carves.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
        db.impressions.bulkPut(impressions.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
        db.catalogs.bulkPut(catalogs.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
      ]);
    }
    await Promise.all([
      db.designs.bulkPut(designs.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
      db.catalogs
        .where('stoneId')
        .equals(stoneId)
        .toArray()
        .then((rows) =>
          db.catalogs.bulkPut(rows.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
        ),
      db.stones.update(stoneId, { withdrawn: true, updatedAt: now } as never),
    ]);
  });
}

/** 级联撤回印稿 → 工序 / 钤印 / 印谱条目，并重编号印谱（软删除） */
export async function removeDesignCascade(designId: string): Promise<void> {
  const now = Date.now();
  const catalog = await db.catalogs.where('designId').equals(designId).toArray();
  const stoneId = catalog[0]?.stoneId;
  await db.transaction('rw', [db.designs, db.carves, db.impressions, db.catalogs], async () => {
    const [carves, impressions, catalogs] = await Promise.all([
      db.carves.where('designId').equals(designId).toArray(),
      db.impressions.where('designId').equals(designId).toArray(),
      db.catalogs.where('designId').equals(designId).toArray(),
    ]);
    await Promise.all([
      db.carves.bulkPut(carves.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
      db.impressions.bulkPut(impressions.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
      db.catalogs.bulkPut(catalogs.map((row) => ({ ...row, withdrawn: true, updatedAt: now }))),
      db.designs.update(designId, { withdrawn: true, updatedAt: now } as never),
    ]);
  });
  if (stoneId) await renumberCatalog(stoneId);
}

/** 撤回单条记录（软删除） */
export async function markRecordWithdrawn(table: TableName, id: string): Promise<void> {
  const now = Date.now();
  await db.table(table).update(id, { withdrawn: true, updatedAt: now } as never);
}

/** 印谱条目按序重编号（排序号连续，仅未撤回条目参与） */
export async function renumberCatalog(stoneId?: string): Promise<void> {
  const rows = stoneId
    ? await db.catalogs.where('stoneId').equals(stoneId).toArray()
    : await db.catalogs.toArray();
  const active = rows.filter((row) => !row.withdrawn);
  const sorted = [...active].sort((a, b) =>
    a.orderNo === b.orderNo ? a.createdAt - b.createdAt : a.orderNo - b.orderNo,
  );
  await db.catalogs.bulkPut(sorted.map((row, index) => ({ ...row, orderNo: index + 1, updatedAt: Date.now() })));
}
