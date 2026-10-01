<script lang="ts">
  /**
   * <MergePreview> 交接包合并预览
   * 分类列出新增 / 修改 / 撤回 / 冲突；冲突项可展开裁决（印石 / 印稿）或显示自动合并说明。
   */
  import ConflictAdjudicator from './ConflictAdjudicator.svelte';
  import { TABLE_LABEL, type MergePreview } from '$lib/types/batch';

  interface Props {
    preview: MergePreview;
  }

  let { preview }: Props = $props();

  const groups = $derived({
    add: preview.changes.filter((c) => c.kind === 'add'),
    modify: preview.changes.filter((c) => c.kind === 'modify'),
    withdraw: preview.changes.filter((c) => c.kind === 'withdraw'),
    conflict: preview.changes.filter((c) => c.kind === 'conflict'),
  });

  const categoryMeta = [
    { key: 'add' as const, label: '新增', tone: '#3f6b57', desc: '包内新增，本机没有' },
    { key: 'modify' as const, label: '修改', tone: '#b98a3c', desc: '包内改过，本机未改' },
    { key: 'withdraw' as const, label: '撤回', tone: '#4c5254', desc: '包内已撤回，本机将同步撤回' },
    { key: 'conflict' as const, label: '冲突', tone: '#9c2b1f', desc: '两边都改过，需裁决或自动合并' },
  ];

  function autoMergeNote(table: string): string {
    if (table === 'carves') return '工序两边都有改动：保留两边记录，按刀法时长重排序';
    if (table === 'impressions') return '钤印两边都有改动：按印稿+日期+纸张去重，取较优评级';
    if (table === 'catalogs') return '印谱两边都有改动：保留包内版本，完成后统一重算顺序';
    return '';
  }
</script>

<div class="space-y-4">
  <div class="rounded-xl border border-line bg-paper-light p-4">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p class="text-sm text-ink-soft">交接包</p>
        <p class="text-lg text-ink">{preview.batch.no} · {preview.batch.machineName}</p>
      </div>
      <div class="text-right text-xs text-ink-soft">
        <p>执刀人：{preview.batch.operator}</p>
        <p>导出时间：{new Date(preview.batch.exportedAt).toLocaleString('zh-CN')}</p>
        <p>包内记录：{preview.recordCount} 条{preview.hasBase ? '' : ' · 无基线（按时间戳合并）'}</p>
      </div>
    </div>
    {#if preview.batch.note}
      <p class="mt-2 border-t border-line pt-2 text-xs text-ink-soft">备注：{preview.batch.note}</p>
    {/if}
  </div>

  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
    {#each categoryMeta as meta (meta.key)}
      <div class="rounded-xl border border-line bg-paper-light p-3" style="border-left: 4px solid {meta.tone}">
        <p class="text-xs text-ink-soft">{meta.label}</p>
        <p class="text-2xl font-bold tabular-nums" style="color: {meta.tone}">
          {groups[meta.key].length}
        </p>
        <p class="mt-0.5 text-xs text-ink-soft">{meta.desc}</p>
      </div>
    {/each}
  </div>

  {#each categoryMeta as meta (meta.key)}
    {@const list = groups[meta.key]}
    {#if list.length > 0}
      <section class="rounded-xl border border-line bg-paper-light p-4">
        <h3 class="mb-2 text-base text-ink">
          {meta.label}
          <span class="ml-1 text-sm text-ink-soft">{list.length} 条</span>
        </h3>
        <ul class="space-y-2">
          {#each list as change (`${change.table}:${change.recordId}`)}
            <li class="rounded-lg border border-line bg-white/60 px-3 py-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded-full bg-black/5 px-2 py-0.5 text-xs text-ink-soft">
                  {TABLE_LABEL[change.table]}
                </span>
                <span class="text-sm text-ink">{change.title}</span>
                {#if change.stoneName}
                  <span class="text-xs text-ink-soft">· {change.stoneName}</span>
                {/if}
                {#if change.changedFields && change.changedFields.length > 0}
                  <span class="text-xs text-amber">改动：{change.changedFields.join('、')}</span>
                {/if}
              </div>
              {#if change.kind === 'conflict' && change.fieldConflicts}
                <ConflictAdjudicator {change} />
              {:else if change.kind === 'conflict'}
                <p class="mt-1 text-xs text-ink-soft">{autoMergeNote(change.table)}</p>
              {/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  {/each}
</div>
