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
import { listChildrenSafely, listDescendantsSafely, buildRow, settledIndex, SeenCursor } from './collect.js';
import { readStopReasonFromLog } from './projection-registry.js';

export const TOOL_NAME = 'what_subagents_are_doing';

/**
 * 行 schema。
 *
 * 刻意保持精简：DSH 只断言 output.schema 的结构合法性（register 里
 * assertSupportedJsonSchema），而模型实际读到的是 render 之后的纯文本，
 * 不是这份 JSON。字段语义都写进工具 description，不在这里重复。
 *
 * 少写一层 additionalProperties: false 就能省几十个 token，而静态成本
 * 是每轮都付的。
 */
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
    settled: { type: 'string' },
    settledSecondsAgo: { type: 'number' },
    stopReason: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        message: { type: 'string' },
        code: { type: 'string' },
        via: { type: 'string' },
      },
      required: ['kind'],
    },
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
        'children (default) = direct children. descendants = the whole tree, '
        + 'each row carrying parent and depth.',
    },
    limit: {
      type: 'number',
      description:
        `Narration entries per subagent, 1-${MAX_LIMIT}. Default ${DEFAULT_LIMIT}.`,
    },
    before: {
      type: 'number',
      description:
        'Page back: return only entries with seq STRICTLY LESS THAN this value. '
        + 'Pass the oldestSeq reported in a previous call. Passing 1 returns nothing, '
        + 'because seq starts at 0 and older entries have smaller seq.',
    },
    includeNarration: {
      type: 'boolean',
      description:
        'Include narration text. Default true; false gives a compact status-only listing.',
    },
  },
};

/**
 * 工具描述。
 *
 * 三条措辞是硬要求：
 * - 开头必须写清"什么时候该用"。只说"这是什么"模型不会主动想起它：
 *   派完子代理就去干别的，直到结算通知才回头，中途没有理由来查。
 * - state 是启发式，必须讲死，否则模型会把正常等待误判成故障
 * - 结尾必须给"一次检查是正常的"留口子。原先是无条件的
 *   "Do not poll in a loop"，容易被读成"别查，等通知"，
 *   而通知只在结算时来——正好堵死了中途查进度的动机。
 *
 * 其余字段语义尽量压短：静态成本每轮都付。
 * @returns {string}
 */
function describeTool() {
  return [
    'Use this when you want to know how far a running subagent has gotten, or',
    'when one has been quiet longer than its task should take and you cannot',
    'tell whether it finished, failed, or is stuck.',
    '',
    'state: running = working; idle = not working now (may have finished, or be',
    'waiting on its own children); possibly-stuck = idle a while, a heuristic',
    'meaning "worth a look", NOT proof of failure; external = off-machine, no',
    'progress available.',
    '',
    'narration is the last few notes the child wrote; narrationTotal counts all',
    'of them and narrationOmitted counts what is not shown. Pass before (a',
    'previous oldestSeq) to page back. narrationSinceLastLook appears once you',
    'have looked before.',
    '',
    'One check when you are curious or suspicious is exactly what this is for.',
    'Do not poll in a loop: settlement already notifies you.',
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

    // 终止原因：区分"正常干完"和"被截断/报错/中断"。
    // 后者是最容易被误读成"它失败了"的情况，必须写明白。
    if (row.stopReason !== undefined) {
      lines.push(`    ${describeStopReason(row.stopReason)}`);
    }

    // 已结束子代理：显示它最后说的话
    if (row.settled !== undefined) {
      const ago = typeof row.settledSecondsAgo === 'number'
        ? `, ${row.settledSecondsAgo}s ago`
        : '';
      lines.push(`    closing message${ago}:`);
      lines.push(`      ${row.settled}`);
    }

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
 * 把终止原因渲染成人话。
 *
 * 关键是让父代理能区分三种情况：
 * - completed：正常干完，可以信它的结论
 * - max-tokens / interrupted / aborted：**没干完**，结论可能残缺，要重新派
 * - error：出错了，看 message 决定重试还是换路
 *
 * 不说清楚的话，父代理容易把"被截断的半截话"当成完整结论。
 *
 * @param {{kind: string, message?: string, code?: string, via?: string}} stop
 * @returns {string}
 */
function describeStopReason(stop) {
  const kind = stop.kind;
  let human;
  switch (kind) {
    case 'completed':
      human = 'finished normally';
      break;
    case 'max-tokens':
      human = 'STOPPED by the output token limit — its answer was cut off mid-thought, '
        + 'so treat the closing message as incomplete and re-delegate if you need the rest';
      break;
    case 'interrupted':
      human = 'INTERRUPTED before finishing — the closing message is not a final answer';
      break;
    case 'aborted':
      human = `ABORTED before finishing${stop.via !== undefined ? ` (by ${stop.via})` : ''}`
        + ' — the closing message is not a final answer';
      break;
    case 'error': {
      const bits = ['FAILED with an error'];
      if (stop.code !== undefined) bits.push(`[${stop.code}]`);
      if (stop.message !== undefined) bits.push(`: ${stop.message}`);
      else bits.push(' (no message recorded)');
      human = bits.join('');
      break;
    }
    default:
      human = `ended with reason "${kind}"`;
  }
  return `stop reason: ${human}`;
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

      // 子代理结束后子会话卸载，收尾语只留在父会话的结算事件里。
      const settled = settledIndex(ctx, parent.id);

      const rows = [];
      for (const entry of listed.entries) {
        const childId = entry.id ?? entry.childId;
        if (typeof childId !== 'string' || childId.length === 0) continue;
        // 一次性子代理无法继续，模型也用不到它的进度。
        if (entry.mode !== undefined && entry.mode !== 'continuable' && entry.mode !== 'external') {
          continue;
        }
        const row = buildRow(ctx, entry, {
          limit,
          before,
          includeNarration,
          stuckMs: config?.stuckMs ?? DEFAULT_STUCK_MS,
          now,
          parentId: parent.id,
          cursor,
          settled,
        });

        // 内存里读不到说明子会话已卸载——正是最需要终止原因的时候。
        // 只在缺 stopReason 且确实没进度时回退读日志，正常路径不付这个代价。
        if (row.stopReason === undefined && row.narration !== undefined
          && row.narration.length === 0) {
          const fromLog = await readStopReasonFromLog(ctx, childId, exec.signal);
          if (fromLog !== undefined) row.stopReason = fromLog;
        }

        rows.push(row);
      }
      return rows;
    },
  };

  ctx.tools.register(definition);
}
