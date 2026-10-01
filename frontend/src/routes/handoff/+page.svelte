<script lang="ts">
  /**
   * /handoff 离线交接
   * - 各机一批：查看当前批次、本批新增/修改/撤回预览，导出离线交接包（JSON）；
   * - 导入交接包先列新增、修改、撤回和冲突（印石冲突进入裁决），确认后一起生效；
   * - 工序双改保留两边按刀法时长重排，钤印重复按日期+纸张识别；
   * - 导入失败可恢复（回滚点），成功后重算印谱顺序。
   */
  import { onMount } from 'svelte';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import MergeReview from '$lib/components/handoff/MergeReview.svelte';
  import { carves, loadCarves } from '$lib/stores/carveStore';
  import { designs, loadDesigns } from '$lib/stores/designStore';
  import { impressions, loadImpressions } from '$lib/stores/impressionStore';
  import { loadStones, stones } from '$lib/stores/stoneStore';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import type { Catalog } from '$lib/types/catalog';
  import { DB_VERSION } from '$lib/utils/db';
  import { download, stampSuffix } from '$lib/utils/export';
  import { TABLE_LABEL, buildRowContext, rowTitle, designTextOf } from '$lib/utils/handoffView';
  import {
    buildHandoffPackage,
    parseHandoffFile,
    applyHandoffMerge,
    getAppliedBatchIds,
    AlreadyAppliedError,
    UnresolvedConflictError,
    ensureActiveBatch,
    getActiveBatchMeta,
    getBatchBases,
    getRollbackPoint,
    restoreRollbackPoint,
    type RollbackPoint,
  } from '$lib/utils/handoff';
  import {
    getMachineIdentity,
    validateHandoff,
    buildMergePlan,
    previewBatchChanges,
    isBatchAlreadyApplied,
    fieldOf,
    type ActiveBatch,
    type BatchBases,
    type ConflictResolution,
    type HandoffPackage,
    type LocalData,
    type MergePlan,
    type SyncRow,
  } from '$lib/utils/sync';
  import { reloadAllData } from '$lib/stores/syncStore';

  const catalogTable = useIdbTable<Catalog>((database) => database.catalogs, { sortByUpdatedAt: false });
  const catalogRows = catalogTable.rows;

  let ready = $state(false);
  let toast = $state('');
  let toastTone = $state<'ok' | 'err'>('ok');
  let active = $state<ActiveBatch | null>(null);
  let bases = $state<BatchBases>({});
  let rollback = $state<RollbackPoint | null>(null);
  const identity = getMachineIdentity();

  // 导入审核状态
  let fileInput = $state<HTMLInputElement | null>(null);
  let reviewOpen = $state(false);
  let importing = $state(false);
  let pendingPkg = $state<HandoffPackage | null>(null);
  let pendingPlan = $state<MergePlan | null>(null);
  // $state 深层响应式代理：ConflictList 直接改字段即可刷新，无需整体替换
  let resolutions = $state<Record<string, ConflictResolution>>({});

  const local: LocalData = $derived({
    stones: $stones as never,
    designs: $designs as never,
    carves: $carves as never,
    impressions: $impressions as never,
    catalogs: $catalogRows as never,
  });

  const batchPreview = $derived(active ? previewBatchChanges(active, local, bases) : []);
  const previewCount = $derived({
    add: batchPreview.filter((item) => item.kind === 'add').length,
    update: batchPreview.filter((item) => item.kind === 'update').length,
    withdraw: batchPreview.filter((item) => item.kind === 'withdraw').length,
  });

  const context = $derived(buildRowContext(local));

  function showToast(text: string, tone: 'ok' | 'err' = 'ok'): void {
    toast = text;
    toastTone = tone;
    setTimeout(() => (toast = ''), 3200);
  }

  async function refreshMeta(): Promise<void> {
    const meta = await getActiveBatchMeta();
    active = meta?.active ?? null;
    bases = await getBatchBases();
    rollback = (await getRollbackPoint()) ?? null;
  }

  onMount(async () => {
    try {
      await ensureActiveBatch();
      await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions(), catalogTable.refresh()]);
      await refreshMeta();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '批次初始化失败', 'err');
    } finally {
      ready = true;
    }
  });

  async function handleExport(): Promise<void> {
    try {
      const pkg = await buildHandoffPackage();
      const total =
        pkg.changes.stones.length +
        pkg.changes.designs.length +
        pkg.changes.carves.length +
        pkg.changes.impressions.length +
        pkg.changes.catalogs.length;
      if (total === 0) showToast('本批次暂无改动，仍可导出空交接包用于登记', 'err');
      download(
        `gbsealcarve-handoff-${stampSuffix()}.json`,
        JSON.stringify(pkg, null, 2),
        'application/json;charset=utf-8',
      );
      showToast(`已导出交接包（${total} 行变更，批次尾号 ${pkg.batchId.slice(-6)}）`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : '交接包导出失败', 'err');
    }
  }

  async function handleImportFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const pkg = await parseHandoffFile(file);
      const invalid = validateHandoff(pkg);
      if (invalid) {
        showToast(invalid, 'err');
        return;
      }
      const appliedBatchIds = await getAppliedBatchIds();
      if (isBatchAlreadyApplied(appliedBatchIds, pkg)) {
        showToast('该批次交接包已在本机导入过，不能重复合并', 'err');
        return;
      }
      const plan = buildMergePlan(pkg, local);
      pendingPkg = pkg;
      pendingPlan = plan;
      const initial: Record<string, ConflictResolution> = {};
      for (const conflict of plan.conflicts) initial[conflict.id] = conflict.resolution;
      resolutions = initial;
      reviewOpen = true;
    } catch {
      showToast('JSON 解析失败，请确认是离线交接包文件', 'err');
    }
  }

  async function confirmMerge(): Promise<void> {
    if (!pendingPkg) return;
    importing = true;
    try {
      const result = await applyHandoffMerge(pendingPkg, resolutions);
      reviewOpen = false;
      await Promise.all([reloadAllData(), catalogTable.refresh(), refreshMeta()]);
      const a = result.applied;
      showToast(
        `合并完成：新增 ${a.adds} · 修改 ${a.updates} · 撤回 ${a.withdraws} · 冲突裁决 ${a.conflicts} · 工序双改 ${a.carveDesigns} 稿 · 重复钤印 ${a.impressionDups} 组，印谱顺序已重算`,
      );
    } catch (err) {
      if (err instanceof AlreadyAppliedError) {
        reviewOpen = false;
        showToast(err.message, 'err');
      } else if (err instanceof UnresolvedConflictError) {
        showToast(err.message, 'err');
      } else {
        showToast(
          `合并失败，已恢复到导入前状态（也可手动点「恢复到导入前」）：${err instanceof Error ? err.message : '未知错误'}`,
          'err',
        );
        await refreshMeta();
      }
    } finally {
      importing = false;
    }
  }

  async function handleRestore(): Promise<void> {
    if (!window.confirm('将放弃最近一次导入/合并后的全部改动，恢复到操作前的备份。是否继续？')) return;
    const ok = await restoreRollbackPoint();
    await Promise.all([reloadAllData(), catalogTable.refresh(), refreshMeta()]);
    showToast(ok ? '已恢复到导入前状态' : '没有可恢复的备份', ok ? 'ok' : 'err');
  }

  function rowOf(table: keyof LocalData, id: string) {
    return local[table].find((row) => row.id === id);
  }

  function previewParent(table: keyof LocalData, row: SyncRow | undefined): string {
    if (table === 'stones' || table === 'designs' || !row) return '';
    return designTextOf(context, fieldOf(row, 'designId'));
  }
</script>

{#if !ready}
  <div class="rounded-xl border border-line bg-paper-light px-4 py-6 text-sm text-ink-soft">正在读取批次与本地档案…</div>
{:else}
  <div class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 class="text-xl tracking-wide text-ink">离线交接</h2>
        <p class="mt-1 text-sm text-ink-soft">
          各机一批 · 先列新增 / 修改 / 撤回 / 冲突，确认后一起生效 · 结构 v{DB_VERSION}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" onclick={() => void handleExport()}>导出本批交接包</button>
        <button class="gb-btn-primary" onclick={() => fileInput?.click()}>导入交接包合并</button>
        <input
          bind:this={fileInput}
          type="file"
          accept="application/json,.json"
          class="hidden"
          onchange={(event) => void handleImportFile(event)}
        />
      </div>
    </div>

    {#if toast}
      <div
        class="rounded-xl border px-4 py-2 text-sm {toastTone === 'ok'
          ? 'border-jade/40 bg-jade/10 text-jade'
          : 'border-seal/40 bg-seal/10 text-seal'}"
      >
        {toast}
      </div>
    {/if}

    <div class="grid gap-3 md:grid-cols-4">
      <StatBadge label="本批新增" value={previewCount.add} suffix="行" tone="jade" />
      <StatBadge label="本批修改" value={previewCount.update} suffix="行" tone="seal" />
      <StatBadge label="本批撤回" value={previewCount.withdraw} suffix="行" tone="ink" />
      <StatBadge label="本机" value={identity.machineName} tone="amber" />
    </div>

    <section class="gb-panel space-y-2">
      <h3 class="text-base text-ink">当前批次</h3>
      {#if active}
        <dl class="grid gap-2 text-sm text-ink-soft md:grid-cols-2">
          <div>批次：{active.label}（{active.id}）</div>
          <div>开批时间：{new Date(active.startedAt).toLocaleString('zh-CN')}</div>
          <div>本机：{identity.machineName}（{identity.machineId}）</div>
          <div>基线：开批时全量快照，交接包仅携带改动行与旧值</div>
        </dl>
      {:else}
        <p class="text-sm text-ink-soft">尚未开批，导入或导出时会自动以当前档案为基线建批。</p>
      {/if}
    </section>

    <section class="gb-panel">
      <h3 class="mb-2 text-base text-ink">本批改动预览</h3>
      {#if batchPreview.length === 0}
        <p class="py-6 text-center text-sm text-ink-soft">本批次暂无改动。在各业务页补刻、换稿、钤印后回到本页导出。</p>
      {:else}
        <div class="max-h-[320px] overflow-auto">
          <table class="gb-table">
            <thead>
              <tr>
                <th class="w-20">类型</th>
                <th class="w-28">表</th>
                <th>记录</th>
              </tr>
            </thead>
            <tbody>
              {#each batchPreview as item (item.table + item.id + item.kind)}
                {@const row = rowOf(item.table, item.id)}
                <tr>
                  <td>
                    <span
                      class="rounded px-1.5 py-0.5 text-xs {item.kind === 'add'
                        ? 'bg-jade/15 text-jade'
                        : item.kind === 'update'
                          ? 'bg-sky-400/15 text-sky-700'
                          : 'bg-ink/10 text-ink-soft'}"
                    >
                      {item.kind === 'add' ? '新增' : item.kind === 'update' ? '修改' : '撤回'}
                    </span>
                  </td>
                  <td class="text-xs text-ink-soft">{TABLE_LABEL[item.table]}</td>
                  <td>
                    <span class="text-sm text-ink">{rowTitle(item.table, row)}</span>
                    {#if previewParent(item.table, row)}
                      <span class="ml-2 text-xs text-ink-soft">{previewParent(item.table, row)}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>

    <section class="gb-panel space-y-2">
      <h3 class="text-base text-ink">合并规则</h3>
      <ul class="list-disc space-y-1 pl-5 text-sm text-ink-soft">
        <li>新增 / 修改 / 撤回按三方对比（开批基线 · 本机 · 对方）自动归类。</li>
        <li>同一印稿两边都改过工序：两边记录都保留，按刀法时长从短到长重排并编号。</li>
        <li>印石信息两边都改：进入冲突裁决，逐项选「保留本机 / 采用对方」后方可生效。</li>
        <li>钤印重复（同稿 + 同日期 + 同纸张 + 同印泥）按评级择优，同级取更新较晚者。</li>
        <li>撤回为软删除标记，跨机同步；本机改过而对方撤回时进入冲突，由人工裁决。</li>
        <li>导入前自动备份，失败自动恢复；生效后全局重算印谱顺序。</li>
      </ul>
      {#if rollback}
        <div class="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-amber/40 bg-amber/[0.06] px-3 py-2">
          <p class="text-xs text-ink-soft">
            存在导入前备份：{new Date(rollback.savedAt).toLocaleString('zh-CN')}（{rollback.reason}）
          </p>
          <button class="gb-btn-danger px-2 py-1 text-xs" onclick={() => void handleRestore()}>恢复到导入前</button>
        </div>
      {/if}
    </section>
  </div>
{/if}

{#if reviewOpen && pendingPlan && pendingPkg}
  <MergeReview
    pkg={pendingPkg}
    plan={pendingPlan}
    {resolutions}
    applying={importing}
    onclose={() => (reviewOpen = false)}
    onconfirm={() => void confirmMerge()}
  />
{/if}
