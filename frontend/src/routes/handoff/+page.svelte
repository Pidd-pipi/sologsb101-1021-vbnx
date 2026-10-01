<script lang="ts">
  /**
   * /handoff 离线交接
   * 各机一批：导出交接包 → 回社导入，先预览新增 / 修改 / 撤回 / 冲突，确认后一起生效。
   * 冲突按实体裁决：印石 / 印稿字段级裁决；工序两边保留并重排；钤印按日期+纸张去重；
   * 生效后重算印谱顺序。导入失败可还原；另一个标签页保存时提示刷新。
   */
  import { onMount } from 'svelte';
  import MergePreview from '$lib/components/handoff/MergePreview.svelte';
  import { useTabGuard } from '$lib/hooks/useTabGuard';
  import {
    batchRecords,
    clearPreview,
    confirmMerge,
    exportCurrentHandoff,
    handoffApplying,
    handoffError,
    handoffParsing,
    handoffToast,
    loadBatchRecords,
    loadHandoffFromText,
    machineInfo,
    mergePreview,
    undoLastMerge,
  } from '$lib/stores/handoffStore';
  import { loadStones } from '$lib/stores/stoneStore';
  import { loadDesigns } from '$lib/stores/designStore';
  import { loadCarves } from '$lib/stores/carveStore';
  import { loadImpressions } from '$lib/stores/impressionStore';
  import { DB_NAME, DB_VERSION, readRestorePoint } from '$lib/utils/db';

  const { externalWrite, externalLease } = useTabGuard();

  let fileInput = $state<HTMLInputElement | null>(null);
  let exporting = $state(false);
  let canUndo = $state(false);

  onMount(() => {
    void loadBatchRecords();
    canUndo = !!readRestorePoint();
  });

  async function handleFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if ($externalWrite) {
      window.alert('数据已在其他标签页保存，请先刷新本页后再导入，避免覆盖。');
      return;
    }
    const text = await file.text();
    const ok = await loadHandoffFromText(text);
    if (ok) {
      // 预览已写入 store，页面响应式渲染
    }
  }

  async function handleConfirm(): Promise<void> {
    const ok = await confirmMerge();
    if (ok) {
      await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions()]);
      canUndo = true;
    }
  }

  async function handleExport(): Promise<void> {
    if ($externalWrite) {
      window.alert('数据已在其他标签页保存，请先刷新本页后再导出。');
      return;
    }
    exporting = true;
    try {
      const no = await exportCurrentHandoff();
      $handoffToast = `交接包 ${no} 已导出`;
    } finally {
      exporting = false;
    }
  }

  async function handleUndo(): Promise<void> {
    if (!window.confirm('确定恢复到本次导入前的状态？导入后的改动将被撤销。')) return;
    const ok = await undoLastMerge();
    if (ok) {
      await Promise.all([loadStones(), loadDesigns(), loadCarves(), loadImpressions()]);
      canUndo = false;
    }
  }

  function refreshPage(): void {
    window.location.reload();
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-xl tracking-wide text-ink">离线交接</h2>
      <p class="mt-1 text-sm text-ink-soft">
        各机一批 · 回社合并 · 先预览后生效 · 本地库 {DB_NAME} v{DB_VERSION}
      </p>
    </div>
  </div>

  {#if $externalWrite}
    <div class="rounded-xl border border-seal/40 bg-seal/10 px-4 py-3 text-sm text-seal">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span>
          检测到其他标签页已保存数据（{$externalLease?.reason ?? '写入'}），为避免覆盖，请先刷新本页再操作。
        </span>
        <button class="gb-btn-primary" onclick={refreshPage}>刷新页面</button>
      </div>
    </div>
  {/if}

  {#if $handoffToast}
    <div class="rounded-xl border border-jade/40 bg-jade/10 px-4 py-2 text-sm text-jade">{$handoffToast}</div>
  {/if}
  {#if $handoffError}
    <div class="rounded-xl border border-seal/40 bg-seal/10 px-4 py-2 text-sm text-seal">{$handoffError}</div>
  {/if}

  <div class="grid gap-4 lg:grid-cols-2">
    <section class="gb-panel space-y-3">
      <h3 class="text-base text-ink">① 导出本机交接包</h3>
      <p class="text-xs text-ink-soft">
        会场无网络时，把本机当前全部档案（含撤回标记与基线快照）打包成 JSON，回社后在合并机导入。
      </p>
      <div class="space-y-2">
        <label class="block">
          <span class="gb-label">机器名（如：1号机）</span>
          <input class="gb-input" bind:value={$machineInfo.machineName} placeholder="1号机" />
        </label>
        <label class="block">
          <span class="gb-label">执刀人</span>
          <input class="gb-input" bind:value={$machineInfo.operator} placeholder="顾墨" />
        </label>
        <label class="block">
          <span class="gb-label">备注</span>
          <input class="gb-input" bind:value={$machineInfo.note} placeholder="如：上海评审会" />
        </label>
      </div>
      <button class="gb-btn-primary" disabled={exporting || $externalWrite} onclick={() => void handleExport()}>
        {exporting ? '正在打包…' : '导出交接包'}
      </button>
    </section>

    <section class="gb-panel space-y-3">
      <h3 class="text-base text-ink">② 导入交接包并合并</h3>
      <p class="text-xs text-ink-soft">
        先列出新增 / 修改 / 撤回 / 冲突，确认后一起生效；冲突可逐字段裁决，工序两边保留并重排，钤印按日期+纸张去重。
      </p>
      <div class="flex flex-wrap gap-2">
        <button class="gb-btn" disabled={$handoffParsing || $externalWrite} onclick={() => fileInput?.click()}>
          {$handoffParsing ? '正在解析…' : '选择交接包文件'}
        </button>
        {#if canUndo}
          <button class="gb-btn-danger" disabled={$handoffApplying} onclick={() => void handleUndo()}>
            撤销上次导入
          </button>
        {/if}
        <input
          bind:this={fileInput}
          type="file"
          accept="application/json,.json"
          class="hidden"
          onchange={(event) => void handleFile(event)}
        />
      </div>
      <p class="text-xs text-ink-soft">
        生效前自动保存还原点，失败自动回滚；生效后重算印谱顺序并更新基线。
      </p>
    </section>
  </div>

  {#if $mergePreview}
    <section class="gb-panel space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-base text-ink">③ 确认合并</h3>
        <div class="flex gap-2">
          <button class="gb-btn" disabled={$handoffApplying} onclick={clearPreview}>取消</button>
          <button class="gb-btn-primary" disabled={$handoffApplying} onclick={() => void handleConfirm()}>
            {$handoffApplying ? '正在生效…' : '确认生效'}
          </button>
        </div>
      </div>
      <MergePreview preview={$mergePreview} />
    </section>
  {/if}

  <section class="gb-panel">
    <h3 class="mb-3 text-base text-ink">已导入批次</h3>
    {#if $batchRecords.length === 0}
      <p class="text-sm text-ink-soft">尚未导入过交接包。</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="gb-table">
          <thead>
            <tr>
              <th>批次号</th>
              <th>机器</th>
              <th>执刀人</th>
              <th>记录数</th>
              <th>导出时间</th>
              <th>导入时间</th>
            </tr>
          </thead>
          <tbody>
            {#each $batchRecords as batch (batch.id)}
              <tr>
                <td class="whitespace-nowrap">{batch.no}</td>
                <td>{batch.machineName}</td>
                <td>{batch.operator}</td>
                <td class="tabular-nums">{batch.recordCount}</td>
                <td class="whitespace-nowrap text-xs">{new Date(batch.exportedAt).toLocaleString('zh-CN')}</td>
                <td class="whitespace-nowrap text-xs">{new Date(batch.importedAt).toLocaleString('zh-CN')}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
</div>
