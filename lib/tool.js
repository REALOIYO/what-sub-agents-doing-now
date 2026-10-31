/**
 * 工具注册：what_subagents_are_doing
 *
 * 刻意不与上游 list_agents 同名。原因两条：
 * 1. dsh-tools 里同名注册直接抛 "tool ... is already registered"；
 * 2. 走 per-agent scope 遮蔽会让模型同时拿到两套语义冲突的工具
 *    （上游 #7642 已实证：调用报 active teammate not found）。
 *
 * 本文件不 import 任何 @deepseek-ai/* 包。
 * 原因：插件从工作区（profile 外）加载时，裸包名解析不到 asar 内的
 * dsh/node_modules——实测 ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools。
 * ctx.tools.register 接受普通对象，defineTool 只是它的便捷包装，
 * 所以这里直接构造标准 JSON Schema，绕开那个依赖。
 */

import {
  DEFAULT_STUCK_MS,
  clampLimit,
  MAX_LIMIT,
  DEFAULT_LIMIT,
} from './paginate.js';
import { listChildrenSafely, listDescendantsSafely, buildRow, SeenCursor } from './collect.js';

export const TOOL_NAME = 'what_subagents_are_doing';

/** 行 schema。标准 JSON Schema 子集，register 内部会自校验。 */
const ROW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    mode: { type: 'string' },
    state: { type: 'string' },
    idleSeconds: { type: 'number' },
    steps: { type: 'number' },
    lastTool: { type: 'string' },
    narration: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['seq', 'text'],
      },
    },
    narrationTotal: { type: 'number' },
    narrationOmitted: { type: 'number' },
    narrationSinceLastLook: { type: 'number' },
    oldestSeq: { type: 'number' },
    note: { type: 'string' },
    parent: { type: 'string' },
    depth: { type: 'number' },
  },
  required: ['id', 'label', 'mode', 'state'],
};

/** 参数 schema。 */
const PARAMETERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scope: {
      type: 'string',
      enum: ['children', 'descendants'],
      description:
        'children (default) lists your direct children. '
        + 'descendants lists the whole tree below you, with each entry\'s parent and depth.',
    },
    limit: {
      type: 'number',
      description:
        `How many narration entries to return per subagent (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}).`,
    },
    before: {
      type: 'number',
      description:
        'Only include narration entries older than this seq. '
        + 'Pass the oldestSeq from a previous call to page further back.',
    },
    includeNarration: {
      type: 'boolean',
      description:
        'Include narration text. Defaults to true. Set false for a compact status-only listing.',
    },
  },
};

/**
 * 工具描述。
 *
 * state 是启发式，措辞必须讲死，否则模型会把正常等待误判成故障。
 * @returns {string}
 */
function describeTool() {
  return [
    'Show what each of your subagents is doing right now, based on the progress',
    'notes it wrote itself — not just running/inactive.',
    '',
    'Each row reports a state:',
    '- running: the child is actively working.',
    '- idle: the child is not working right now (it may have finished, or be',
    '  waiting on its own descendants).',
    '- possibly-stuck: no activity for a while. This is a heuristic meaning',
    '  "worth a look", NOT proof that the child failed.',
    '- external: the child runs outside this machine; progress is unavailable.',
    '',
    'narration holds the last few notes the child wrote. narrationTotal is how',
    'many it has written in all, and narrationOmitted is how many are not shown.',
    'To look further back, pass before (the oldestSeq from a previous call).',
    'narrationSinceLastLook appears once you have looked before, and counts the',
    'notes added since then.',
    '',
    'Use this instead of guessing or waiting. Do not poll it in a loop: you are',
    'still notified when a subagent settles.',
  ].join('\n');
}

/**
 * 把行渲染成模型可读文本。
 * @param {Array} rows
 * @returns {Array<{type: 'text', text: string}>}
 */
function renderRows(rows) {
  if (rows.length === 0) return [{ type: 'text', text: '(no subagents)' }];

  const lines = [];
  for (const row of rows) {
    const head = [`${row.id} [${row.state}]`];
    if (row.parent !== undefined) head.push(`parent=${row.parent}`);
    if (row.depth !== undefined) head.push(`depth=${row.depth}`);
    lines.push(`${head.join(' ')} — ${row.label}`);

    const detail = [];
    if (row.steps !== undefined) detail.push(`${row.steps} steps`);
    if (row.lastTool !== undefined) detail.push(`last tool: ${row.lastTool}`);
    if (typeof row.idleSeconds === 'number') detail.push(`idle ${row.idleSeconds}s`);
    if (detail.length > 0) lines.push(`    ${detail.join(', ')}`);

    if (row.note !== undefined) lines.push(`    note: ${row.note}`);

    if (Array.isArray(row.narration) && row.narration.length > 0) {
      if (row.narrationSinceLastLook !== undefined) {
        lines.push(`    (+${row.narrationSinceLastLook} since you last looked)`);
      }
      for (const item of row.narration) {
        lines.push(`    • ${item.text}`);
      }
      if (row.narrationOmitted > 0) {
        lines.push(
          `    (showing ${row.narration.length} of ${row.narrationTotal}; `
          + `${row.narrationOmitted} older omitted — pass before=${row.oldestSeq} to see them)`,
        );
      }
    }
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * 注册工具。
 * @param {any} ctx
 * @param {object} config - { stuckMs }
 */
export function registerTool(ctx, config) {
  const cursor = new SeenCursor();

  const definition = {
    name: TOOL_NAME,
    description: describeTool(),
    parameters: PARAMETERS_SCHEMA,
    output: {
      schema: { type: 'array', items: ROW_SCHEMA },
      render: (_args, rows) => renderRows(rows),
    },
    async execute(args, exec) {
      const parent = exec?.agent;
      if (parent === undefined) {
        throw new Error(`${TOOL_NAME} requires a calling agent (exec.agent was undefined)`);
      }

      const scope = args?.scope === 'descendants' ? 'descendants' : 'children';
      const limit = clampLimit(args?.limit);
      const includeNarration = args?.includeNarration !== false;
      const before = typeof args?.before === 'number' && Number.isFinite(args.before)
        ? args.before
        : undefined;
      const now = Date.now();

      const listed = scope === 'descendants'
        ? await listDescendantsSafely(ctx, parent.id, exec.signal)
        : await listChildrenSafely(ctx, parent.id, exec.signal);

      if (!listed.ok) {
        // 显式失败，不返回空数组：空数组会让模型以为"没有子代理"。
        throw new Error(
          `${TOOL_NAME} could not read the subagent catalog (${listed.reason}): ${listed.detail}`,
        );
      }

      const rows = [];
      for (const entry of listed.entries) {
        const childId = entry.id ?? entry.childId;
        if (typeof childId !== 'string' || childId.length === 0) continue;
        // 一次性子代理无法继续，模型也用不到它的进度。
        if (entry.mode !== undefined && entry.mode !== 'continuable' && entry.mode !== 'external') {
          continue;
        }
        rows.push(buildRow(ctx, entry, {
          limit,
          before,
          includeNarration,
          stuckMs: config?.stuckMs ?? DEFAULT_STUCK_MS,
          now,
          parentId: parent.id,
          cursor,
        }));
      }
      return rows;
    },
  };

  ctx.tools.register(definition);
}
