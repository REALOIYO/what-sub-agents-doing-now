/**
 * 纯逻辑：分页、计数、游标、状态判定。
 *
 * 刻意不 import 任何 @deepseek-ai/* 包——这些函数要能脱离 DSH 运行时
 * 单独跑单测（test/projection.test.mjs 直接 node 执行）。
 * ctx 只作为参数注入，不在此文件里取任何服务。
 */

/** 默认回传的旁白条数。 */
export const DEFAULT_LIMIT = 6;

/** 单次回传的旁白条数上限，防止一次拉爆上下文。 */
export const MAX_LIMIT = 50;

/** 默认的"多久没动静算可能卡住"阈值（毫秒）。 */
export const DEFAULT_STUCK_MS = 120_000;

/**
 * 把 limit 夹到合法区间。
 * @param {unknown} value
 * @returns {number}
 */
export function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT;
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

/**
 * 从旁白数组里按 before 游标取一页。
 *
 * 语义：取 seq < before 的最近 limit 条。before 缺省时取全部里最近的 limit 条。
 * 返回顺序始终是 seq 递增（最老在前、最新在后），与阅读顺序一致。
 *
 * @param {Array<{seq: number, time: number, text: string}>} narration
 * @param {number} limit
 * @param {number|undefined} before
 * @returns {{page: Array, omitted: number, total: number, oldestSeq: number|null}}
 */
export function pageNarration(narration, limit, before) {
  const total = narration.length;
  if (total === 0) return { page: [], omitted: 0, total: 0, oldestSeq: null };

  const filtered = before === undefined
    ? narration
    : narration.filter((item) => item.seq < before);

  const page = filtered.slice(Math.max(0, filtered.length - limit));
  return {
    page,
    omitted: Math.max(0, filtered.length - page.length),
    total,
    oldestSeq: page.length > 0 ? page[0].seq : null,
  };
}

/**
 * 数出 seq 大于 afterSeq 的旁白条数。
 *
 * 这才是"自上次查看后新增几条"的准确答案：seq 差会把中间的
 * tool/call 等事件也算进去，必须按实际旁白条目数。
 *
 * @param {Array<{seq: number}>} narration
 * @param {number|undefined} afterSeq
 * @returns {number|undefined} afterSeq 为 undefined 时返回 undefined。
 */
export function countSince(narration, afterSeq) {
  if (afterSeq === undefined) return undefined;
  let count = 0;
  for (const item of narration) {
    if (item.seq > afterSeq) count += 1;
  }
  return count;
}

/**
 * "上次看到哪"的内存游标。
 *
 * 只存在内存里：进程重启即失效，失效时省略增量字段（不影响正确性）。
 * key 用 `${parentId}:${childId}`——同一个子代理可能被多个父级观察，
 * 各父级的游标互不干扰；不同的子代理之间天然隔离。
 */
export class SeenCursor {
  constructor() {
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }

  /**
   * 读上次看到的 seq。
   * @param {string} parentId
   * @param {string} childId
   * @returns {number|undefined}
   */
  read(parentId, childId) {
    return this.seen.get(`${parentId}:${childId}`);
  }

  /**
   * 写当前看到的 seq。
   * @param {string} parentId
   * @param {string} childId
   * @param {number} latestSeq
   */
  write(parentId, childId, latestSeq) {
    this.seen.set(`${parentId}:${childId}`, latestSeq);
  }
}

/**
 * 判定单个子代理的状态。
 *
 * agents.get(id).status 只有 running / inactive，inactive 覆盖了
 * "干完了""崩了""卡住了""在等下级" 四种情况。lastAt 是唯一可用的抓手。
 *
 * 注意：这是启发式。possibly-stuck 的语义是"该看一眼了"，不是"它坏了"。
 *
 * @param {{agents?: {get?: (id: string) => any}}} ctx
 * @param {string} childId
 * @param {number} lastAt - 最后一次活动时间戳；0 表示无记录。
 * @param {number} now - 当前时间（由调用方注入，便于测试）。
 * @param {number} stuckMs
 * @returns {{state: string, idleSeconds: number|null}}
 */
export function classifyState(ctx, childId, lastAt, now, stuckMs) {
  let running = false;
  try {
    running = ctx?.agents?.get?.(childId)?.status === 'running';
  } catch {
    running = false;
  }

  if (running) return { state: 'running', idleSeconds: 0 };

  if (!(lastAt > 0)) {
    // 完全没有活动记录：不知道多久没动，不臆断为卡住。
    return { state: 'idle', idleSeconds: null };
  }

  const idleMs = Math.max(0, now - lastAt);
  const idleSeconds = Math.round(idleMs / 1000);
  return idleMs > stuckMs
    ? { state: 'possibly-stuck', idleSeconds }
    : { state: 'idle', idleSeconds };
}
