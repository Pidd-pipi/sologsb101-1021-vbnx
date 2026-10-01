import {
  buildMergePlan,
  resolveMergeOperations,
  mergeCarveSteps,
  pickImpressionDuplicates,
  LEGACY_BATCH_ID,
  type HandoffPackage,
  type LocalData,
  type SyncRow,
} from '../frontend/src/lib/utils/sync';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL:', msg);
  }
}

const now = 1_700_000_000_000;

function row(table: string, id: string, patch: Record<string, unknown> = {}): SyncRow {
  return {
    id,
    batchId: LEGACY_BATCH_ID,
    withdrawn: false,
    withdrawnAt: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  } as unknown as SyncRow;
}

function emptyLocal(): LocalData {
  return { stones: [], designs: [], carves: [], impressions: [], catalogs: [] };
}

function pkg(changes: Partial<LocalData>, bases: Record<string, SyncRow>, batchId = 'batch_A'): HandoffPackage {
  return {
    app: 'gbsealcarve',
    kind: 'handoff',
    schemaVersion: 3,
    batchId,
    machineId: 'dev_A',
    machineName: '甲机',
    startedAt: now,
    packedAt: new Date().toISOString(),
    label: '评审',
    changes: { ...emptyLocal(), ...changes },
    bases,
  };
}

// ---------- 1. 新增 ----------
{
  const local = emptyLocal();
  const incoming = row('stones', 'stone_99', { name: '新石', stoneType: 'balin' });
  const plan = buildMergePlan(pkg({ stones: [incoming] }, {}), local);
  assert(plan.adds.length === 1 && plan.adds[0]?.id === 'stone_99', '新增：对方独有的印石应归为新增');
}

// ---------- 2. 修改（仅对方改） ----------
{
  const local = emptyLocal();
  local.stones = [row('stones', 'stone_01', { name: '原名', state: 'idle' })];
  const base = row('stones', 'stone_01', { name: '原名', state: 'idle' });
  const incoming = row('stones', 'stone_01', { name: '新名', state: 'idle', updatedAt: now + 1000 });
  const plan = buildMergePlan(pkg({ stones: [incoming] }, { stone_01: base }), local);
  assert(plan.updates.length === 1, '修改：仅对方改名应归为修改');
}

// ---------- 3. 双方都改印石 → 冲突，必须裁决 ----------
{
  const local = emptyLocal();
  local.stones = [row('stones', 'stone_01', { name: '本机名', state: 'idle', updatedAt: now + 2000 })];
  const base = row('stones', 'stone_01', { name: '原名', state: 'idle' });
  const incoming = row('stones', 'stone_01', { name: '对方名', state: 'idle', updatedAt: now + 1000 });
  const plan = buildMergePlan(pkg({ stones: [incoming] }, { stone_01: base }), local);
  assert(plan.conflicts.length === 1 && plan.conflicts[0]?.table === 'stones', '印石双改应产生冲突');
  // 未裁决必须抛错
  let threw = false;
  try {
    resolveMergeOperations(plan, {}, 'batch_local');
  } catch {
    threw = true;
  }
  assert(threw, '印石冲突未裁决时应拒绝生效');
  const ops = resolveMergeOperations(plan, { stone_01: 'incoming' }, 'batch_local');
  assert(ops.puts[0]?.table === 'stones' && (ops.puts[0]?.row as unknown as { name: string }).name === '对方名', '裁决采用对方应写入对方值');
}

// ---------- 4. 撤回：本机未动，对方撤回 ----------
{
  const local = emptyLocal();
  local.impressions = [row('impressions', 'impr_1', { grade: 'good' })];
  const base = row('impressions', 'impr_1', { grade: 'good' });
  const incoming = row('impressions', 'impr_1', { grade: 'good', withdrawn: true, withdrawnAt: now + 500 });
  const plan = buildMergePlan(pkg({ impressions: [incoming] }, { impr_1: base }), local);
  assert(plan.withdraws.length === 1, '对方撤回、本机未改应归为撤回');
}

// ---------- 5. 本机改过 + 对方撤回 → 冲突 ----------
{
  const local = emptyLocal();
  local.impressions = [row('impressions', 'impr_1', { grade: 'excellent' })];
  const base = row('impressions', 'impr_1', { grade: 'good' });
  const incoming = row('impressions', 'impr_1', { grade: 'good', withdrawn: true });
  const plan = buildMergePlan(pkg({ impressions: [incoming] }, { impr_1: base }), local);
  assert(plan.conflicts.length === 1, '本机改、对方撤回应为冲突');
  assert(plan.conflicts[0]?.reason === 'local-modified-remote-withdrawn', '冲突原因应为 local-modified-remote-withdrawn');
}

// ---------- 6. 工序双改：保留两边，按刀法时长重排 ----------
{
  const local = emptyLocal();
  local.carves = [
    row('carves', 'c1', { designId: 'd1', seq: 1, knifeMethod: 'chong', minutes: 40, state: 'doing' }),
    row('carves', 'c2', { designId: 'd1', seq: 2, knifeMethod: 'trim', minutes: 15, state: 'done' }),
  ];
  const baseC1 = row('carves', 'c1', { designId: 'd1', seq: 1, knifeMethod: 'chong', minutes: 40, state: 'todo' });
  const baseC2 = row('carves', 'c2', { designId: 'd1', seq: 2, knifeMethod: 'trim', minutes: 15, state: 'todo' });
  const incomingChanged = row('carves', 'c1', { designId: 'd1', seq: 1, knifeMethod: 'chong', minutes: 45, state: 'todo' });
  const incomingNew = row('carves', 'c3', { designId: 'd1', seq: 2, knifeMethod: 'qie', minutes: 30, state: 'todo' });
  const plan = buildMergePlan(
    pkg({ carves: [incomingChanged, incomingNew] }, { c1: baseC1, c2: baseC2 }),
    local,
  );
  assert(plan.carveGroups.length === 1, '同稿工序两边都改应产生合并组');
  const merged = plan.carveGroups[0]?.merged ?? [];
  assert(merged.length === 4, `两边工序记录都应保留（期望 4，实际 ${merged.length}）`);
  const minutes = merged.map((c) => c.minutes);
  assert(JSON.stringify(minutes) === JSON.stringify([15, 30, 40, 45]), `应按刀法时长升序（实际 ${minutes.join(',')}）`);
  assert(merged[0]?.seq === 1 && merged[3]?.seq === 4, '序号应重编为 1..4');
}

// ---------- 7. 工序合并纯函数：同 id 对方行复制新 id ----------
{
  const a = [row('carves', 'x', { minutes: 40 }) as never];
  const b = [row('carves', 'x', { minutes: 20 }) as never, row('carves', 'y', { minutes: 10 }) as never];
  const group = mergeCarveSteps(a as never, b as never);
  assert(group.merged.length === 3, '同 id 工序应复制而非覆盖，保留两边 3 条');
  assert(group.remappedIds.length === 1, '同 id 对方行应产生 1 个新 id 映射');
}

// ---------- 8. 钤印重复：同稿同日同纸张同印泥，评级高者胜 ----------
{
  const localRows = [
    row('impressions', 'i1', { designId: 'd1', stampedAt: '2026-03-01', paperType: 'lianshi', inkBrand: '西泠印泥', grade: 'good', updatedAt: 1 }) as never,
  ];
  const incomingRows = [
    row('impressions', 'i2', { designId: 'd1', stampedAt: '2026-03-01', paperType: 'lianshi', inkBrand: '西泠印泥', grade: 'excellent', updatedAt: 2 }) as never,
  ];
  const groups = pickImpressionDuplicates(localRows, incomingRows);
  assert(groups.length === 1, '同稿同日同纸张同印泥应识别为重复');
  assert(groups[0]?.winner.id === 'i2', '评级优者应胜出');
}

// ---------- 9. 不同纸张不算重复 ----------
{
  const localRows = [
    row('impressions', 'i1', { designId: 'd1', stampedAt: '2026-03-01', paperType: 'lianshi', inkBrand: '西泠印泥', grade: 'good' }) as never,
  ];
  const incomingRows = [
    row('impressions', 'i2', { designId: 'd1', stampedAt: '2026-03-01', paperType: 'xuan', inkBrand: '西泠印泥', grade: 'excellent' }) as never,
  ];
  const groups = pickImpressionDuplicates(localRows, incomingRows);
  assert(groups.length === 0, '不同纸张不应算重复');
}

// ---------- 10. 同记录两边一致 → 跳过 ----------
{
  const local = emptyLocal();
  local.stones = [row('stones', 's1', { name: '同', state: 'idle' })];
  const base = row('stones', 's1', { name: '旧', state: 'idle' });
  const incoming = row('stones', 's1', { name: '同', state: 'idle' });
  const plan = buildMergePlan(pkg({ stones: [incoming] }, { s1: base }), local);
  assert(plan.adds.length + plan.updates.length + plan.conflicts.length === 0, '两边一致应无变更');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
