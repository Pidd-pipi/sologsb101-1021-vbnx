/**
 * 数据库层端到端冒烟（fake-indexeddb）：
 * 甲机建批 → 改工序/印石/钤印 → 导出交接包；
 * 同一库再模拟乙机改动 → 导入合并：
 * 工序两边保留按时长重排、印石冲突裁决、钤印去重撤回、批次防重、回滚恢复。
 */
import 'fake-indexeddb/auto';

// localStorage / sessionStorage / BroadcastChannel 最小桩
const memory = new Map<string, string>();
(globalThis as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (memory.has(k) ? (memory.get(k) as string) : null),
  setItem: (k: string, v: string) => void memory.set(k, String(v)),
  removeItem: (k: string) => void memory.delete(k),
  clear: () => memory.clear(),
  key: () => null,
  length: 0,
} as Storage;
const sessionMemory = new Map<string, string>();
(globalThis as { sessionStorage: Storage }).sessionStorage = {
  getItem: (k: string) => (sessionMemory.has(k) ? (sessionMemory.get(k) as string) : null),
  setItem: (k: string, v: string) => void sessionMemory.set(k, String(v)),
  removeItem: (k: string) => void sessionMemory.delete(k),
  clear: () => sessionMemory.clear(),
  key: () => null,
  length: 0,
} as Storage;
class FakeChannel {
  onmessage: ((event: { data: string }) => void) | null = null;
  postMessage(): void {}
  close(): void {}
}
(globalThis as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
  FakeChannel as unknown as typeof BroadcastChannel;

import assert from 'node:assert';
import { db, initDatabase } from '../frontend/src/lib/utils/db';
import {
  applyHandoffMerge,
  buildHandoffPackage,
  ensureActiveBatch,
  getActiveBatch,
  getRollbackPoint,
  loadAllData,
  restoreRollbackPoint,
} from '../frontend/src/lib/utils/handoff';
import { buildMergePlan } from '../frontend/src/lib/utils/sync';

async function main(): Promise<void> {
  await initDatabase();
  await ensureActiveBatch();
  const batch = await getActiveBatch();
  assert.ok(batch, '活动批次应已建立');

  // 甲机改动
  const t0 = Date.now() + 100_000;
  await db.stones.update('stone_01', { name: '甲机改名-寿山', updatedAt: t0 });
  await db.carves.put({
    id: 'carve_020104_A',
    designId: 'design_0201',
    seq: 4,
    knifeMethod: 'qie',
    minutes: 8,
    operator: '甲机',
    state: 'done',
    createdAt: t0,
    updatedAt: t0,
    batchId: batch!.id,
  });
  await db.impressions.put({
    id: 'impr_A_1',
    designId: 'design_0101',
    inkBrand: '西泠印泥',
    paperType: 'lianshi',
    pressure: 'medium',
    grade: 'good',
    stampedAt: '2026-01-20',
    note: '',
    createdAt: t0,
    updatedAt: t0,
    batchId: batch!.id,
  });

  const handoffPkg = await buildHandoffPackage();
  assert.strictEqual(handoffPkg.batchId, batch!.id);
  assert.ok(handoffPkg.changes.stones.some((s) => s.id === 'stone_01'), '交接包含改动印石');
  assert.ok(handoffPkg.changes.carves.some((c) => c.id === 'carve_020104_A'), '交接包含新增工序');
  assert.ok(handoffPkg.bases.stone_01, '交接包携带基线');

  // 模拟乙机在合并目标库上的改动（晚于甲机）
  const t1 = t0 + 50_000;
  await db.stones.update('stone_01', { name: '乙机改名-寿山', updatedAt: t1 });
  await db.carves.put({
    id: 'carve_020105_B',
    designId: 'design_0201',
    seq: 5,
    knifeMethod: 'trim',
    minutes: 12,
    operator: '乙机',
    state: 'done',
    createdAt: t1,
    updatedAt: t1,
    batchId: 'batch_B',
  });

  // 让 stone_01 基线为旧名，构成真三方冲突
  handoffPkg.bases.stone_01 = { ...handoffPkg.bases.stone_01, name: '寿山黄芙蓉方章' } as never;

  const localData = await loadAllData();
  const plan = buildMergePlan(handoffPkg, localData);
  assert.ok(plan.conflicts.some((c) => c.id === 'stone_01'), '印石两边都改应进入裁决');
  assert.ok(plan.carveGroups.some((g) => g.designId === 'design_0201'), '工序双改应形成合并组');

  const resolutions: Record<string, 'local' | 'incoming'> = {};
  for (const c of plan.conflicts) resolutions[c.id] = c.id === 'stone_01' ? 'incoming' : c.resolution;

  // 未全部裁决印石时应拒绝（临时不给 stone_01 裁决）
  const incomplete = { ...resolutions };
  delete incomplete.stone_01;
  await assert.rejects(() => applyHandoffMerge(handoffPkg, incomplete), /未裁决/, '印石未裁决应拒绝生效');

  const result = await applyHandoffMerge(handoffPkg, resolutions);

  const stone01 = await db.stones.get('stone_01');
  assert.strictEqual(stone01?.name, '甲机改名-寿山', '印石应按裁决取甲机值');

  const carves = (await db.carves.where('designId').equals('design_0201').toArray())
    .filter((c) => !c.withdrawn)
    .sort((a, b) => a.seq - b.seq);
  const ids = carves.map((c) => c.id);
  assert.ok(ids.includes('carve_020104_A'), '甲机工序保留');
  assert.ok(ids.includes('carve_020105_B'), '乙机工序保留');
  const minutes = carves.map((c) => c.minutes);
  assert.deepStrictEqual(minutes, [...minutes].sort((a, b) => a - b), '工序按时长升序');
  assert.deepStrictEqual(carves.map((c) => c.seq), carves.map((_, i) => i + 1), '序号连续');

  const imprA = await db.impressions.get('impr_A_1');
  assert.strictEqual(imprA?.withdrawn, true, '重复钤印落选行应撤回');

  assert.ok(result.applied.carveDesigns >= 1, '报告工序双改稿数');

  // 批次防重
  await assert.rejects(() => applyHandoffMerge(handoffPkg, resolutions), /已导入过/, '同批次不可重复合并');

  // 回滚恢复
  const point = await getRollbackPoint();
  assert.ok(point, '应留存回滚点');
  assert.ok(await restoreRollbackPoint(), '回滚恢复成功');
  const restoredStone = await db.stones.get('stone_01');
  assert.strictEqual(restoredStone?.name, '乙机改名-寿山', '恢复后回到合并前状态');

  console.log('E2E OK:', JSON.stringify(result.applied));
  process.exit(0);
}

main().catch((err) => {
  console.error('E2E FAIL', err);
  process.exit(1);
});
