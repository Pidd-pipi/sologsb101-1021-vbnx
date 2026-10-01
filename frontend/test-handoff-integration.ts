/**
 * 离线交接合并流程集成测试（fake-indexeddb + vite-node）
 * 运行：npx vite-node test-handoff-integration.ts
 */
import 'fake-indexeddb/auto';

// Node 环境无 localStorage，打内存 mock
const localStorageMock = (() => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
})();
(globalThis as unknown as { localStorage: Storage }).localStorage = localStorageMock as unknown as Storage;

import { db, initDatabase, captureSnapshot, writeBaseSnapshot, readBaseSnapshot } from './src/lib/utils/db';
import {
  computeMergePreview,
  applyMerge,
  exportHandoffPackage,
  parseHandoffPackage,
  type ExportMachineInfo,
} from './src/lib/utils/handoff';
import type { HandoffPackage } from './src/lib/types/batch';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; }
  else { failed++; console.error('FAIL:', msg); }
}

async function main() {
  // 初始化数据库（播种演示数据）
  await initDatabase();
  const initialStones = await db.stones.toArray();
  assert(initialStones.length > 0, '数据库初始化后有印石数据');

  // 场景 1：导出交接包
  const info: ExportMachineInfo = {
    machineId: 'machine_test',
    machineName: '测试机',
    operator: '测试员',
    note: '集成测试',
  };
  const pkg = await exportHandoffPackage(info);
  assert(pkg.batch.machineName === '测试机', '交接包机器名正确');
  assert(pkg.stones.length === initialStones.length, '交接包包含全部印石');
  assert(pkg.base.stones.length === initialStones.length, '交接包包含基线快照');

  // 场景 2：修改本地数据（模拟本机离线改动）
  const stone = initialStones[0];
  const originalName = stone.name;
  await db.stones.update(stone.id, { name: '本机修改的印石名', updatedAt: Date.now() });

  // 场景 3：构造一个包内也修改了同一印石的交接包（冲突）
  const remotePkg: HandoffPackage = JSON.parse(JSON.stringify(pkg));
  const remoteStone = remotePkg.stones.find((s) => s.id === stone.id)!;
  remoteStone.name = '包内修改的印石名';
  remoteStone.updatedAt = Date.now() + 1000;
  // 包内新增一条钤印
  const remoteDesign = remotePkg.designs[0];
  remotePkg.impressions.push({
    id: 'impr_test_new',
    designId: remoteDesign.id,
    inkBrand: '西泠印泥',
    paperType: 'xuan',
    pressure: 'medium',
    grade: 'excellent',
    stampedAt: '2026-09-01',
    note: '包内新增钤印',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  remotePkg.batch.id = 'batch_remote_test';
  remotePkg.batch.no = '20260901-1200';

  // 场景 4：计算预览
  const preview = await computeMergePreview(remotePkg);
  assert(preview.conflictCount >= 1, `检测到冲突（实际 ${preview.conflictCount}）`);
  assert(preview.addCount >= 1, `检测到新增（实际 ${preview.addCount}）`);
  const stoneConflict = preview.changes.find(
    (c) => c.table === 'stones' && c.recordId === stone.id && c.kind === 'conflict',
  );
  assert(!!stoneConflict, '印石冲突被识别');
  assert(!!stoneConflict?.fieldConflicts?.some((fc) => fc.field === 'name'), '印石 name 字段冲突');

  // 场景 5：裁决选择本地
  if (stoneConflict?.fieldConflicts) {
    const nameConflict = stoneConflict.fieldConflicts.find((fc) => fc.field === 'name')!;
    nameConflict.choice = 'local';
  }

  // 场景 6：生效合并
  const result = await applyMerge(remotePkg, preview);
  assert(result.conflictCount >= 1, '合并结果包含冲突数');
  assert(result.addCount >= 1, '合并结果包含新增数');

  // 验证：印石名保留本地选择
  const mergedStone = await db.stones.get(stone.id);
  assert(mergedStone?.name === '本机修改的印石名', '裁决后保留本地印石名');

  // 验证：新增钤印已加入
  const newImpression = await db.impressions.get('impr_test_new');
  assert(!!newImpression, '包内新增钤印已生效');

  // 验证：基线快照已更新
  const newBase = readBaseSnapshot();
  assert(!!newBase, '基线快照已更新');

  // 场景 7：撤回传播
  const withdrawPkg: HandoffPackage = JSON.parse(JSON.stringify(pkg));
  withdrawPkg.batch.id = 'batch_withdraw_test';
  withdrawPkg.batch.no = '20260901-1300';
  // 撤回一条印石
  const withdrawStone = withdrawPkg.stones[1];
  withdrawStone.withdrawn = true;
  withdrawStone.updatedAt = Date.now();
  const preview2 = await computeMergePreview(withdrawPkg);
  assert(preview2.withdrawCount >= 1, `检测到撤回（实际 ${preview2.withdrawCount}）`);
  await applyMerge(withdrawPkg, preview2);
  const afterWithdraw = await db.stones.get(withdrawStone.id);
  assert(afterWithdraw?.withdrawn === true, '撤回已同步到本地');

  // 场景 8：解析校验
  const { error: err1 } = parseHandoffPackage('not json');
  assert(!!err1, '非法 JSON 被拒绝');
  const { error: err2 } = parseHandoffPackage(JSON.stringify({ app: 'wrong' }));
  assert(!!err2, '错误 app 被拒绝');
  const { pkg: parsed, error: err3 } = parseHandoffPackage(JSON.stringify(pkg));
  assert(!err3 && !!parsed, '合法交接包解析通过');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
