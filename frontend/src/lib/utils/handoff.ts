/**
 * 离线交接 IO 层：批次基线、交接包打包/解析、事务化合并生效、导入回滚恢复。
 *
 * 安全保证：
 * - 合并 / 覆盖导入前先把当前全库存入 kvmeta 回滚点；写入全部在单个 Dexie 事务内，
 *   任一步失败整体回滚；事务外仍失败时自动按回滚点恢复（导入失败后能恢复）。
 * - 同一批次包只应用一次（appliedBatches 记录），重复导入直接提示。
 * - 合并生效后全局重算印谱顺序（renumberCatalog）。
 */
import {
  db,
  getMeta,
  setMeta,
  deleteMeta,
  META_KEYS,
  BUSINESS_TABLES,
  renumberCatalog,
  importSnapshot,
  type SealCarveSnapshot,
} from './db';
import {
  TABLE_NAMES,
  HANDOFF_SCHEMA_VERSION,
  getMachineIdentity,
  setMachineName as persistMachineName,
  createBatchId,
  normalizeSyncRow,
  buildMergePlan,
  resolveMergeOperations,
  adoptedFixups,
  collectBatchChanges,
  unresolvedStoneConflicts,
  type ActiveBatch,
  type BatchBases,
  type ConflictResolution,
  type HandoffPackage,
  type LocalData,
  type SyncRow,
  type TableName,
  type MergeOperation,
} from './sync';
import type { Design } from '$lib/types/design';

const LS_ROLLBACK_AT = 'gbsealcarve:rollback-at';

/* ------------------------------ 本机数据读取 ------------------------------ */

export async function loadAllData(): Promise<LocalData> {
  const [stones, designs, carves, impressions, catalogs] = await Promise.all([
    db.stones.toArray(),
    db.designs.toArray(),
    db.carves.toArray(),
    db.impressions.toArray(),
    db.catalogs.toArray(),
  ]);
  return {
    stones: stones as SyncRow[],
    designs: designs as SyncRow[],
    carves: carves as SyncRow[],
    impressions: impressions as SyncRow[],
    catalogs: catalogs as SyncRow[],
  };
}

/* ------------------------------ 活动批次 ------------------------------ */

interface ActiveBatchMeta {
  active: ActiveBatch;
  /** 开批时的基线快照（全量；打包时只携带被改动行的旧值） */
  bases: LocalData;
}

export async function getActiveBatchMeta(): Promise<ActiveBatchMeta | undefined> {
  return getMeta<ActiveBatchMeta>(META_KEYS.activeBatch);
}

export async function getActiveBatch(): Promise<ActiveBatch | undefined> {
  return (await getActiveBatchMeta())?.active;
}

export async function getBatchBases(): Promise<BatchBases> {
  const meta = await getActiveBatchMeta();
  const bases: BatchBases = {};
  if (!meta) return bases;
  for (const table of TABLE_NAMES) {
    for (const row of meta.bases[table]) bases[row.id] = row;
  }
  return bases;
}

/** 以当前全量为基线开新批次（出发去外地评审前 / 合并回社完成后） */
export async function startNewBatch(label: string, startedAt: number = Date.now()): Promise<ActiveBatch> {
  const identity = getMachineIdentity();
  const active: ActiveBatch = {
    id: createBatchId(identity, startedAt),
    machineId: identity.machineId,
    machineName: identity.machineName,
    startedAt,
    label: label.trim() || '外地评审批次',
  };
  const bases = await loadAllData();
  await setMeta(META_KEYS.activeBatch, { active, bases });
  return active;
}

/**
 * 保证存在活动批次（应用启动时调用）。
 * 首次打开（含 v2 自动迁移到 v3 的旧数据）以当前全量为基线建批，
 * 旧数据已由 Dexie upgrade 补齐批次（legacy）与撤回标记。
 */
export async function ensureActiveBatch(): Promise<ActiveBatch> {
  const existing = await getActiveBatchMeta();
  if (existing?.active?.id) return existing.active;
  return startNewBatch('当前评审批次');
}

export async function renameMachine(name: string): Promise<void> {
  persistMachineName(name);
}

/* ------------------------------ 已应用批次 ------------------------------ */

export async function getAppliedBatchIds(): Promise<string[]> {
  return (await getMeta<string[]>(META_KEYS.appliedBatches)) ?? [];
}

async function addAppliedBatch(batchId: string): Promise<void> {
  const list = await getAppliedBatchIds();
  if (!list.includes(batchId)) await setMeta(META_KEYS.appliedBatches, [...list, batchId]);
}

/* ------------------------------ 交接包打包 ------------------------------ */

export async function buildHandoffPackage(): Promise<HandoffPackage> {
  const meta = await getActiveBatchMeta();
  if (!meta) throw new Error('活动批次不存在，请先开批');
  const current = await loadAllData();
  const changes = collectBatchChanges(meta.active, current);

  // 基线只携带本批改动行的旧值（新增行无旧值）
  const changedIds = new Set<string>();
  for (const table of TABLE_NAMES) changes[table].forEach((row) => changedIds.add(row.id));
  const bases: BatchBases = {};
  for (const [id, row] of Object.entries(flatten(meta.bases))) {
    if (changedIds.has(id)) bases[id] = row;
  }

  return {
    app: 'gbsealcarve',
    kind: 'handoff',
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    batchId: meta.active.id,
    machineId: meta.active.machineId,
    machineName: meta.active.machineName,
    startedAt: meta.active.startedAt,
    packedAt: new Date().toISOString(),
    label: meta.active.label,
    changes,
    bases,
  };
}

function flatten(data: LocalData): Record<string, SyncRow> {
  const result: Record<string, SyncRow> = {};
  for (const table of TABLE_NAMES) data[table].forEach((row) => (result[row.id] = row));
  return result;
}

export async function parseHandoffFile(file: File): Promise<HandoffPackage> {
  const text = await file.text();
  return JSON.parse(text) as HandoffPackage;
}

/* ------------------------------ 撤回（软删除） ------------------------------ */

function tableFor(table: TableName) {
  switch (table) {
    case 'stones':
      return db.stones;
    case 'designs':
      return db.designs;
    case 'carves':
      return db.carves;
    case 'impressions':
      return db.impressions;
    case 'catalogs':
      return db.catalogs;
  }
}

/** 撤回一条记录（软删除；交接时同步撤回）。印石/印稿撤回不级联，仅标记本行。 */
export async function withdrawRow(table: TableName, id: string): Promise<void> {
  const active = (await getActiveBatch())?.id;
  const now = Date.now();
  await tableFor(table).update(id, {
    withdrawn: true,
    withdrawnAt: now,
    batchId: active,
    updatedAt: now,
  } as never);
}

/* ------------------------------ 回滚点（导入失败恢复） ------------------------------ */

export interface RollbackPoint {
  savedAt: number;
  reason: string;
  snapshot: LocalData;
}

export async function saveRollbackPoint(reason: string): Promise<RollbackPoint> {
  const snapshot = await loadAllData();
  const point: RollbackPoint = { savedAt: Date.now(), reason, snapshot };
  await setMeta(META_KEYS.rollback, point);
  try {
    localStorage.setItem(LS_ROLLBACK_AT, String(point.savedAt));
  } catch {
    /* ignore */
  }
  return point;
}

export async function getRollbackPoint(): Promise<RollbackPoint | undefined> {
  return getMeta<RollbackPoint>(META_KEYS.rollback);
}

export async function clearRollbackPoint(): Promise<void> {
  await deleteMeta(META_KEYS.rollback);
  try {
    localStorage.removeItem(LS_ROLLBACK_AT);
  } catch {
    /* ignore */
  }
}

/** 按回滚点恢复（导入失败后能恢复） */
export async function restoreRollbackPoint(): Promise<boolean> {
  const point = await getRollbackPoint();
  if (!point) return false;
  await db.transaction('rw', BUSINESS_TABLES.map((name) => db.table(name)), async () => {
    for (const table of TABLE_NAMES) {
      const t = db.table<SyncRow, string>(table);
      await t.clear();
      await t.bulkPut(point.snapshot[table]);
    }
  });
  await clearRollbackPoint();
  return true;
}

/* ------------------------------ 交接合并生效 ------------------------------ */

export interface MergeResult {
  applied: {
    adds: number;
    updates: number;
    withdraws: number;
    conflicts: number;
    carveDesigns: number;
    impressionDups: number;
  };
  batchId: string;
}

export class AlreadyAppliedError extends Error {}
export class UnresolvedConflictError extends Error {}

/**
 * 三方合并并在单事务内生效：
 * 1. 印石冲突必须全部裁决；2. 写入新增/修改/撤回/裁决结果；
 * 3. 双改工序保留两边并按刀法时长重排；4. 钤印重复撤回落选；
 * 5. 同石采用稿唯一修正；6. 提交后全局重算印谱顺序、登记已应用批次。
 */
export async function applyHandoffMerge(
  pkg: HandoffPackage,
  resolutions: Record<string, ConflictResolution>,
): Promise<MergeResult> {
  const applied = await getAppliedBatchIds();
  if (applied.includes(pkg.batchId)) {
    throw new AlreadyAppliedError('该批次交接包已导入过，不能重复合并');
  }

  const local = await loadAllData();
  const plan = buildMergePlan(pkg, local);
  if (unresolvedStoneConflicts(plan, resolutions) > 0) {
    throw new UnresolvedConflictError('尚有印石信息冲突未裁决，请逐项选择「保留本机」或「采用对方」');
  }

  const active = (await getActiveBatch())?.id ?? 'legacy';
  let ops: MergeOperation;
  try {
    ops = resolveMergeOperations(plan, resolutions, active);
  } catch (err) {
    throw new UnresolvedConflictError(err instanceof Error ? err.message : '存在未裁决冲突');
  }

  await saveRollbackPoint(`交接合并：${pkg.machineName}·${pkg.label}`);

  try {
    await db.transaction('rw', BUSINESS_TABLES.map((name) => db.table(name)), async () => {
      // 普通新增 / 修改 / 冲突裁决写入
      for (const { table, row } of ops.puts) {
        await db.table<SyncRow, string>(table).put(normalizeSyncRow(row, active));
      }
      // 撤回（软删除）
      for (const { table, id, withdrawnAt } of ops.withdraws) {
        const existing = await db.table<SyncRow, string>(table).get(id);
        if (existing) {
          await db
            .table<SyncRow, string>(table)
            .put({ ...existing, withdrawn: true, withdrawnAt: withdrawnAt ?? Date.now(), updatedAt: Date.now() });
        }
      }
      // 工序双改：同稿两边记录都保留，整体替换该稿未撤回工序（已按时长重排序号）
      for (const group of ops.carveGroups) {
        const t = db.table<SyncRow, string>('carves');
        const activeRows = await t.where('designId').equals(group.designId).toArray();
        await t.bulkDelete(activeRows.filter((row) => row.withdrawn !== true).map((row) => row.id));
        await t.bulkPut(
          group.merged.map((carve) =>
            normalizeSyncRow(
              { ...carve, batchId: (carve.batchId as string | undefined) || active },
              active,
            ),
          ),
        );
      }
      // 钤印重复：落选行撤回（本机行直接撤回；对方落选行本来就被跳过）
      const impressionTable = db.table<SyncRow, string>('impressions');
      const now = Date.now();
      for (const dup of ops.impressionDups) {
        for (const loser of dup.losers) {
          const existing = await impressionTable.get(loser.id);
          if (existing && existing.withdrawn !== true) {
            await impressionTable.put({ ...existing, withdrawn: true, withdrawnAt: now, updatedAt: now });
          }
        }
      }
      // 同石采用稿唯一修正
      const allDesigns = (await db.designs.toArray()) as Array<Design & SyncRow>;
      const demoted = adoptedFixups(allDesigns);
      if (demoted.length > 0) await db.designs.bulkPut(demoted);

      // 合并完成后在同一事务内重算印谱顺序（撤回条目不占排序号）
      const catalogRows = await db.catalogs.toArray();
      const orderedCatalogs = catalogRows
        .filter((row) => row.withdrawn !== true)
        .sort((a, b) => (a.orderNo === b.orderNo ? a.createdAt - b.createdAt : a.orderNo - b.orderNo));
      const renumberAt = Date.now();
      await db.catalogs.bulkPut(orderedCatalogs.map((row, index) => ({ ...row, orderNo: index + 1, updatedAt: renumberAt })));
    });

    // 批次登记放在事务外（kvmeta 写入失败不应回滚业务合并）
    await addAppliedBatch(pkg.batchId);
    try {
      localStorage.setItem('gbsealcarve:last-merge-at', new Date().toISOString());
    } catch {
      /* ignore */
    }

    return {
      applied: {
        adds: ops.puts.filter((p) => plan.adds.some((a) => a.table === p.table && a.id === p.row.id)).length,
        updates: plan.updates.length,
        withdraws: ops.withdraws.length,
        conflicts: plan.conflicts.length,
        carveDesigns: ops.carveGroups.length,
        impressionDups: ops.impressionDups.length,
      },
      batchId: pkg.batchId,
    };
  } catch (err) {
    // 导入失败：尽力按回滚点恢复
    try {
      await restoreRollbackPoint();
    } catch {
      /* 恢复失败时保留回滚点，供页面手动「恢复到导入前」 */
    }
    throw err;
  }
}

/* ------------------------------ 整库覆盖导入（带回滚） ------------------------------ */

/**
 * 整库覆盖导入（/catalog 旧入口）：先导回滚点再写入；
 * 失败自动恢复；成功后以导入数据为基线重建活动批次并清空已应用批次记录。
 * 旧版本备份由 db.importSnapshot 自动迁移补批次与撤回标记。
 */
export async function replaceAllWithBackup(snapshot: SealCarveSnapshot): Promise<void> {
  await saveRollbackPoint('整库 JSON 覆盖导入');
  try {
    await importSnapshot(snapshot);
  } catch (err) {
    try {
      await restoreRollbackPoint();
    } catch {
      /* 保留回滚点供手动恢复 */
    }
    throw err;
  }
  // 重建活动批次基线（导入数据即新基线），清空已导入批次记录
  await setMeta(META_KEYS.appliedBatches, []);
  await startNewBatch('整库导入后基线');
  await renumberCatalog();
}
