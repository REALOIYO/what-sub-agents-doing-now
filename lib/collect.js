/**
 * 采集与组装：把子代理目录 + 投影状态合成模型可读的行。
 *
 * 纯逻辑（分页/计数/游标/状态判定）在 paginate.js，本文件只做编排。
 * 全部只读：不调 send_message / interrupt_agent，不 append 任何事件。
 */

import { readProgress } from './projection-registry.js';
import {
  DEFAULT_STUCK_MS,
  pageNarration,
  countSince,
  classifyState,
  detectSilence,
} from './paginate.js';

export { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_STUCK_MS, clampLimit, SeenCursor, classifyState } from './paginate.js';

/**
 * 从 listDescendants 的结果里取出直接子级。
 *
 * 0.2.1 起 `ctx.subagents` 的服务接口只剩 listDescendants，listChildren
 * 退化为模块内部函数（见 @deepseek-ai/dsh-subagent/lib/types/list-children.js），
 * 不再挂在服务对象上。直接调用会抛 TypeError，被包成 SUBAGENT_LIST_FAILED。
 *
 * 遍历结果里每条都带 parentId，所以过滤就是精确的：取 parentId === 根
 * 且 kind === 'child' 的行。diagnostic 行是坏掉的分支，不属于任何目录项，
 * 丢掉——它们进 buildRow 只会渲染成一行读不到进度的空记录。
 *
 * @param {Array} all - listDescendants 的原始返回。
 * @param {string} parentId - 作为根的那个会话。
 * @returns {Array}
 */
function directChildrenOf(all, parentId) {
  if (!Array.isArray(all)) return [];
  const out = [];
  for (const entry of all) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.kind !== 'child' || entry.parentId !== parentId) continue;
    // children 视图里父级恒为调用者、深度恒为 1，两个字段都是噪音；
    // 而且 buildRow 认的是 parent 不是 parentId，不剔除也不会误渲，
    // 但 depth 会被原样打到行上，凭空多出一个 depth=1。
    const { depth: _depth, ...rest } = entry;
    out.push(rest);
  }
  return out;
}

/**
 * 拉取直接子代理目录。
 *
 * 失败必须显式返回诊断，绝不能 return []——
 * 空数组会让模型以为"我没有子代理"，比报错更危险。
 *
 * 三条路径按可用性依次尝试，而不是按 DSH 版本号判断：
 * 版本号要写死、而且插件从 profile 外加载时拿不到可靠的版本，
 * 探测方法本身存在与否最直接。
 *
 * @param {any} ctx
 * @param {string} parentId
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ok: true, entries: Array}|{ok: false, reason: string, detail: string}>}
 */
export async function listChildrenSafely(ctx, parentId, signal) {
  const service = ctx?.subagents;

  // 路径一：旧接口。存在就优先用，它只读一层目录，开销最小。
  if (typeof service?.listChildren === 'function') {
    try {
      const entries = await service.listChildren(parentId, signal);
      return { ok: true, entries: Array.isArray(entries) ? entries : [] };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'SUBAGENT_LIST_FAILED';
      return { ok: false, reason: code, detail: error?.message ?? String(error) };
    }
  }

  // 路径二：现行接口。多走几层子树，但每条都带 parentId，过滤后语义一致。
  if (typeof service?.listDescendants === 'function') {
    try {
      const all = await service.listDescendants(parentId, signal);
      return { ok: true, entries: directChildrenOf(all, parentId) };
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'SUBAGENT_LIST_FAILED';
      return { ok: false, reason: code, detail: error?.message ?? String(error) };
    }
  }

  // 两条都不可用：说清缺什么，别让调用方以为"没有子代理"。
  return {
    ok: false,
    reason: 'SUBAGENT_CONTROL_UNAVAILABLE',
    detail: 'the subagents service exposes neither listChildren nor listDescendants; '
      + 'check that @deepseek-ai/dsh-subagent is loaded in this profile',
  };
}

/**
 * 拉取整棵子树。
 * @param {any} ctx
 * @param {string} rootId
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ok: true, entries: Array}|{ok: false, reason: string, detail: string}>}
 */
export async function listDescendantsSafely(ctx, rootId, signal) {
  const service = ctx?.subagents;
  if (typeof service?.listDescendants !== 'function') {
    return {
      ok: false,
      reason: 'SUBAGENT_CONTROL_UNAVAILABLE',
      detail: 'the subagents service does not expose listDescendants; '
        + 'check that @deepseek-ai/dsh-subagent is loaded in this profile',
    };
  }
  try {
    const entries = await service.listDescendants(rootId, signal);
    if (!Array.isArray(entries)) return { ok: true, entries: [] };
    // buildRow 读 entry.parent，服务返回的是 parentId。
    // 不归一化的话子树视图会丢掉父子关系，每行都像直属子级。
    return {
      ok: true,
      entries: entries.map((entry) => (entry !== null && typeof entry === 'object'
        ? { ...entry, parent: entry.parent ?? entry.parentId }
        : entry)),
    };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'SUBAGENT_LIST_FAILED';
    return { ok: false, reason: code, detail: error?.message ?? String(error) };
  }
}

/**
 * 去掉值为 undefined 的键，避免 JSON 里出现噪声。
 * @param {object} obj
 * @returns {object}
 */
function stripUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 从父会话的投影里取子代理结算记录，按 childId 建索引。
 *
 * 子代理结束后 session 会卸载，子会话投影读不到了；但结算通知留在
 * 父会话的 agent/inbox/spliced 事件里，父会话投影能截获它。
 * 这是唯一还能拿到收尾语的路径。
 *
 * @param {any} ctx
 * @param {string} parentId
 * @returns {Map<string, {text: string, time: number}>}
 */
export function settledIndex(ctx, parentId) {
  const index = new Map();
  const state = readProgress(ctx, parentId);
  if (state === undefined || !Array.isArray(state.settled)) return index;
  for (const item of state.settled) {
    if (typeof item?.childId === 'string' && typeof item.text === 'string') {
      index.set(item.childId, { text: item.text, time: item.time });
    }
  }
  return index;
}

/**
 * 把一条目录项 + 投影状态合成对外的行。
 *
 * @param {any} ctx
 * @param {object} entry - catalog 条目（含 id / label / mode）。
 * @param {object} options
 * @returns {object}
 */
export function buildRow(ctx, entry, options) {
  const {
    limit,
    before,
    includeNarration,
    stuckMs = DEFAULT_STUCK_MS,
    now,
    parentId,
    cursor,
  } = options;

  const childId = entry.id ?? entry.childId;
  const row = {
    id: childId,
    label: entry.label ?? '(no label)',
    mode: entry.mode ?? 'unknown',
  };
  if (entry.parent !== undefined) row.parent = entry.parent;
  if (entry.depth !== undefined) row.depth = entry.depth;

  // external 子代理没有本地 Session，读不到旁白。
  if (entry.mode === 'external') {
    row.state = 'external';
    // narration 的 schema 是 array，读不到时必须给空数组 + note 说明，
    // 不能给 null（DSH 的输出校验会拒：必须为 array）。
    if (includeNarration) row.narration = [];
    row.note = 'external execution: no local session, progress unavailable';
    return stripUndefined(row);
  }

  const progress = readProgress(ctx, childId);

  // readProgress 只保证不抛错，挡不住 stateOf 返回 null（未注册、被丢弃、
  // 或 checkpoint ver 不匹配）。这里再挡一次：下面要读 lastAt 和 narration，
  // 任何一个为 undefined 都会让整次工具调用抛 TypeError，比少一行信息糟得多。
  if (progress === null || typeof progress !== 'object') {
    // session 不在内存或投影缺失：显式说明，不假装"没说过话"。
    // 子代理结束后 session 会被卸载，这是最常见的进入条件。
    const { state, idleSeconds } = classifyState(ctx, childId, 0, now, stuckMs);
    row.state = state;
    if (idleSeconds !== null) row.idleSeconds = idleSeconds;
    if (includeNarration) row.narration = [];

    // 结算记录在父会话里，补上最后一句，回溯时至少知道它干完没。
    const settled = options.settled?.get(childId);
    if (settled !== undefined) {
      row.settled = settled.text;
      if (typeof settled.time === 'number' && settled.time > 0) {
        row.settledSecondsAgo = Math.max(0, Math.round((now - settled.time) / 1000));
      }
      row.note = 'session unloaded after settlement; the closing message is preserved below';
    } else {
      row.note = 'progress unavailable: session not resident in memory '
        + '(a finished child is unloaded; this is expected after settlement)';
    }
    return stripUndefined(row);
  }

  const { state, idleSeconds } = classifyState(ctx, childId, progress.lastAt, now, stuckMs);
  row.state = state;
  if (idleSeconds !== null) row.idleSeconds = idleSeconds;
  row.steps = progress.steps;
  if (progress.lastTool !== undefined) row.lastTool = progress.lastTool;

  // 旧版本投影可能没有 narration 字段，或被写坏成非数组。
  // pageNarration 会读 .length，传进去就炸，所以归一化成本地 empty。
  const narration = Array.isArray(progress.narration) ? progress.narration : [];

  if (includeNarration) {
    const { page, omitted, total, oldestSeq } = pageNarration(
      narration,
      limit,
      before,
    );
    row.narration = page.map((item) => ({ seq: item.seq, text: item.text }));
    row.narrationTotal = total;
    row.narrationOmitted = omitted;
    if (oldestSeq !== null) row.oldestSeq = oldestSeq;

    if (cursor !== undefined && page.length > 0) {
      const latestSeq = page[page.length - 1].seq;
      const previous = cursor.read(parentId, childId);

      if (previous !== undefined) {
        const fresh = countSince(narration, previous.seq);
        if (fresh !== undefined) row.narrationSinceLastLook = fresh;
        if (typeof previous.steps === 'number') {
          row.stepsSinceLastLook = progress.steps - previous.steps;
        }
      }

      // 只看"没写旁白"不够，得看"走了不少步却没写旁白"。
      // 正常汇报的节奏约 2-5 步一条，连续 5 步零条才值得提示。
      if (typeof row.stepsSinceLastLook === 'number') {
        const silence = detectSilence(
          row.stepsSinceLastLook,
          row.narrationSinceLastLook ?? 0,
        );
        if (silence !== undefined && silence.silent) {
          row.silentSteps = silence.steps;
        }
      }

      cursor.write(parentId, childId, {
        seq: latestSeq,
        steps: progress.steps,
        narrationTotal: total,
      });
    }
  }

  return stripUndefined(row);
}
