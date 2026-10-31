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
} from './paginate.js';

export { DEFAULT_LIMIT, MAX_LIMIT, DEFAULT_STUCK_MS, clampLimit, SeenCursor, classifyState } from './paginate.js';

/**
 * 拉取直接子代理目录。
 *
 * 失败必须显式返回诊断，绝不能 return []——
 * 空数组会让模型以为"我没有子代理"，比报错更危险。
 *
 * @param {any} ctx
 * @param {string} parentId
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ok: true, entries: Array}|{ok: false, reason: string, detail: string}>}
 */
export async function listChildrenSafely(ctx, parentId, signal) {
  try {
    const entries = await ctx.subagents.listChildren(parentId, signal);
    return { ok: true, entries: Array.isArray(entries) ? entries : [] };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'SUBAGENT_LIST_FAILED';
    return { ok: false, reason: code, detail: error?.message ?? String(error) };
  }
}

/**
 * 拉取整棵子树。
 * @param {any} ctx
 * @param {string} rootId
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ok: true, entries: Array}|{ok: false, reason: string, detail: string}>}
 */
export async function listDescendantsSafely(ctx, rootId, signal) {
  try {
    const entries = await ctx.subagents.listDescendants(rootId, signal);
    return { ok: true, entries: Array.isArray(entries) ? entries : [] };
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

  if (progress === undefined) {
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

  if (includeNarration) {
    const { page, omitted, total, oldestSeq } = pageNarration(
      progress.narration,
      limit,
      before,
    );
    row.narration = page.map((item) => ({ seq: item.seq, text: item.text }));
    row.narrationTotal = total;
    row.narrationOmitted = omitted;
    if (oldestSeq !== null) row.oldestSeq = oldestSeq;

    if (cursor !== undefined && page.length > 0) {
      const latestSeq = page[page.length - 1].seq;
      const fresh = countSince(progress.narration, cursor.read(parentId, childId));
      if (fresh !== undefined) row.narrationSinceLastLook = fresh;
      cursor.write(parentId, childId, latestSeq);
    }
  }

  return stripUndefined(row);
}
