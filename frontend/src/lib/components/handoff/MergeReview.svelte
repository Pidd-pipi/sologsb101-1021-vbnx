<script lang="ts">
  /**
   * 离线交接 · 合并预览审核对话框
   * 确认前分组列出：新增 / 修改 / 撤回 / 冲突（印石必须裁决）/
   * 工序双改合并（保留两边，按时长重排）/ 钤印重复识别。
   * 确认后由父组件执行事务化合并。
   */
  import ConflictList from './ConflictList.svelte';
  import {
    TABLE_LABEL,
    rowTitle,
    buildRowContext,
    designTextOf,
  } from '$lib/utils/handoffView';
  import { fieldOf } from '$lib/utils/sync';
  import { KNIFE_METHOD_LABEL } from '$lib/types/carve';
  import { GRADE_LABEL, PAPER_KIND_LABEL, type PaperKind } from '$lib/types/impression';
  import type {
    ConflictResolution,
    HandoffPackage,
    MergeItem,
    MergePlan,
  } from '$lib/utils/sync';

  interface Props {
    pkg: HandoffPackage;
    plan: MergePlan;
    resolutions: Record<string, ConflictResolution>;
    applying: boolean;
    onclose: () => void;
    onconfirm: () => void;
  }

  let { pkg, plan, resolutions, applying, onclose, onconfirm }: Props = $props();

  const context = $derived(buildRowContext(plan.local));

  const unresolvedStone = $derived(
    plan.conflicts.filter((c) => c.table === 'stones' && !(c.id in resolutions)).length,
  );
  const canConfirm = $derived(!applying && unresolvedStone === 0);

  const KIND_TONE: Record<string, string> = {
    add: 'border-jade/40 bg-jade/[0.05]',
    update: 'border-sky-400/40 bg-sky-400/[0.06]',
    withdraw: 'border-ink/20 bg-ink/[0.04]',
  };

  function parentText(item: MergeItem): string {
    const row = item.incoming ?? item.local;
    if (!row) return '';
    if (item.table === 'stones' || item.table === 'designs') return '';
    return `印稿：${designTextOf(context, fieldOf(row, 'designId'))}`;
  }

  let tab = $state<'add' | 'update' | 'withdraw' | 'conflict' | 'carve' | 'dup'>('add');

  const tabs = $derived(
    [
      { key: 'add', label: `新增 ${plan.adds.length}` },
      { key: 'update', label: `修改 ${plan.updates.length}` },
      { key: 'withdraw', label: `撤回 ${plan.withdraws.length}` },
      { key: 'conflict', label: `冲突 ${plan.conflicts.length}` },
      { key: 'carve', label: `工序双改 ${plan.carveGroups.length}` },
      { key: 'dup', label: `钤印重复 ${plan.impressionDups.length}` },
    ] as const,
  );
</script>

<div class="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4">
  <div class="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-xl border border-line bg-paper-light shadow-xl">
    <header class="border-b border-line px-5 py-3">
      <h3 class="text-lg text-ink">交接合并预览</h3>
      <p class="mt-0.5 text-xs text-ink-soft">
        来自 {pkg.machineName} · 批次「{pkg.label}」 · 打包于 {new Date(pkg.packedAt).toLocaleString('zh-CN')}
      </p>
    </header>

    <div class="flex flex-wrap gap-1 border-b border-line px-4 py-2 text-sm">
      {#each tabs as item (item.key)}
        <button
          class="rounded-full px-3 py-1 {tab === item.key ? 'bg-seal text-paper-light' : 'text-ink-soft hover:bg-black/5'}"
          onclick={() => (tab = item.key)}
        >
          {item.label}
        </button>
      {/each}
    </div>

    <div class="flex-1 overflow-y-auto px-5 py-4">
      {#if tab === 'add' || tab === 'update'}
        {@const list = tab === 'add' ? plan.adds : plan.updates}
        {#if list.length === 0}
          <p class="py-8 text-center text-sm text-ink-soft">无{tab === 'add' ? '新增' : '修改'}记录</p>
        {:else}
          <ul class="space-y-1.5">
            {#each list as item (item.table + item.id)}
              <li class="rounded-lg border px-3 py-2 text-sm {KIND_TONE[item.kind]}">
                <span class="mr-2 rounded bg-ink/10 px-1.5 py-0.5 text-xs text-ink-soft">
                  {TABLE_LABEL[item.table]}
                </span>
                <span class="text-ink">{rowTitle(item.table, item.incoming)}</span>
                {#if parentText(item)}<span class="ml-2 text-xs text-ink-soft">{parentText(item)}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}

      {#if tab === 'withdraw'}
        {#if plan.withdraws.length === 0}
          <p class="py-8 text-center text-sm text-ink-soft">无撤回记录</p>
        {:else}
          <ul class="space-y-1.5">
            {#each plan.withdraws as item (item.table + item.id)}
              <li class="rounded-lg border px-3 py-2 text-sm {KIND_TONE.withdraw}">
                <span class="mr-2 rounded bg-ink/10 px-1.5 py-0.5 text-xs text-ink-soft">
                  {TABLE_LABEL[item.table]}
                </span>
                <span class="text-ink line-through">{rowTitle(item.table, item.local ?? item.incoming)}</span>
                <span class="ml-2 text-xs text-ink-soft">撤回（保留记录并标记）</span>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}

      {#if tab === 'conflict'}
        {#if plan.conflicts.length === 0}
          <p class="py-8 text-center text-sm text-jade">没有冲突，可直接确认生效。</p>
        {:else}
          <ConflictList conflicts={plan.conflicts} local={plan.local} {resolutions} machineName={pkg.machineName} />
        {/if}
      {/if}

      {#if tab === 'carve'}
        {#if plan.carveGroups.length === 0}
          <p class="py-8 text-center text-sm text-ink-soft">没有两边都改过工序的印稿</p>
        {:else}
          <div class="space-y-3">
            <p class="text-xs text-ink-soft">
              以下印稿的刻制工序两边都改过：两边记录全部保留，按刀法时长从短到长重新排序并编号。
            </p>
            {#each plan.carveGroups as group (group.designId)}
              <section class="rounded-xl border border-line p-3">
                <h4 class="mb-2 text-sm font-medium text-ink">印稿：{designTextOf(context, group.designId)}</h4>
                <ol class="space-y-1 text-xs text-ink-soft">
                  {#each group.merged as step, index (step.id)}
                    <li class="flex gap-2">
                      <span class="w-6 tabular-nums text-ink">{index + 1}.</span>
                      <span>{KNIFE_METHOD_LABEL[step.knifeMethod]} · {step.minutes} 分钟 · {step.operator || '未署执刀人'}</span>
                    </li>
                  {/each}
                </ol>
              </section>
            {/each}
          </div>
        {/if}
      {/if}

      {#if tab === 'dup'}
        {#if plan.impressionDups.length === 0}
          <p class="py-8 text-center text-sm text-ink-soft">没有重复钤印</p>
        {:else}
          <div class="space-y-3">
            <p class="text-xs text-ink-soft">
              同一印稿、同一钤印日期与纸张（印泥相同）视为重复按压：按评级保留较优一枚，评级相同取更新较晚者，其余标记撤回。
            </p>
            {#each plan.impressionDups as group (group.designId + group.stampedAt + group.paperType)}
              <section class="rounded-xl border border-line p-3 text-sm">
                <p class="text-ink">
                  {designTextOf(context, group.designId)} · {group.stampedAt} · {PAPER_KIND_LABEL[group.paperType as PaperKind]}
                </p>
                <p class="mt-1 text-jade">保留：{GRADE_LABEL[group.winner.grade]}（{group.winner.inkBrand}）</p>
                <p class="text-xs text-ink-soft">
                  去重 {group.losers.length} 枚：{group.losers.map((l) => `${GRADE_LABEL[l.grade]}（${l.inkBrand}）`).join('、')}
                </p>
              </section>
            {/each}
          </div>
        {/if}
      {/if}
    </div>

    <footer class="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
      <p class="text-xs text-ink-soft">
        生效前已自动备份当前档案，失败可恢复；生效后自动重算印谱顺序。
        {#if unresolvedStone > 0}<span class="text-seal">还有 {unresolvedStone} 处方石信息冲突待裁决。</span>{/if}
      </p>
      <div class="flex gap-2">
        <button class="gb-btn" onclick={onclose} disabled={applying}>取消</button>
        <button class="gb-btn-primary" disabled={!canConfirm} onclick={onconfirm}>
          {applying ? '正在合并…' : '确认后一起生效'}
        </button>
      </div>
    </footer>
  </div>
</div>
