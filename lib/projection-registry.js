/**
 * 投影注册与读取。
 *
 * 不 import 任何 @deepseek-ai/* 包：插件从 profile 外加载时裸包名解析不到
 * asar 内的 dsh/node_modules（实测 ERR_MODULE_NOT_FOUND）。
 * 投影注册只需要普通对象，schema 用标准 JSON Schema 子集。
 */

import {
  PROJECTION_KEY,
  STATE_VERSION,
  initState,
  applyEvent,
  extractStopReason,
} from './projection.js';

/** 投影状态 schema（标准 JSON Schema 子集）。
 *
 * 注意：DSH 的 assertSupportedJsonSchema 只接受
 * type/oneOf/properties/required/additionalProperties/items/enum/const + 注解，
 * 不接受 maxItems/minLength 等约束关键字。长度上限由 projection.js
 * 的环形缓冲在运行时保证，不写进 schema。
 */
export const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    narration: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          seq: { type: 'number' },
          time: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['seq', 'time', 'text'],
      },
    },
    lastTool: { type: 'string' },
    steps: { type: 'number' },
    lastAt: { type: 'number' },
    lastSeq: { type: 'number' },
    // 本会话作为父级收到过的子代理结算记录。
    // 子会话卸载后，这是唯一还能拿到收尾语的地方。
    settled: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string' },
          time: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['childId', 'time', 'text'],
      },
    },
    // 本会话自己这一轮是怎么结束的。子会话卸载后，父级仍能从这里读到
    // "正常完成 / 被截断 / 报错 / 被中断"，不用再去翻日志。
    stopReason: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string' },
        message: { type: 'string' },
        code: { type: 'string' },
        via: { type: 'string' },
      },
      required: ['kind'],
    },
  },
  required: ['narration', 'steps', 'lastAt', 'lastSeq', 'settled'],
};

/**
 * 把错误链压成一行，便于日志。
 * @param {unknown} error
 * @returns {string}
 */
function errorChain(error) {
  const parts = [];
  let current = error;
  let depth = 0;
  while (current !== undefined && depth < 5) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
    depth += 1;
  }
  return parts.join(' <- ') || 'unknown error';
}

/**
 * 注册投影单元。
 *
 * registration 是 effect，插件卸载时自动注销。
 * 失败不抛：返回 undefined，由调用方降级，绝不能让整个 profile 起不来。
 *
 * @param {any} ctx
 * @returns {(() => void) | undefined}
 */
export function registerProjection(ctx) {
  try {
    return ctx.sessionProjections.register({
      key: PROJECTION_KEY,
      stateSchema: STATE_SCHEMA,
      stateVersion: STATE_VERSION,
      init: initState,
      apply: applyEvent,
      // 不传 wire：host-only 单元，不进客户端快照。
    });
  } catch (error) {
    ctx.logger?.warn?.(
      `[what-sub-agents-doing-now] projection registration failed: ${errorChain(error)}`,
    );
    return undefined;
  }
}

/**
 * 读取某个 session 的投影状态。
 *
 * 返回 undefined 表示读不到（session 不在内存、key 未注册、或读取抛错）。
 * 调用方必须把 undefined 渲染成显式状态，不能当成"空了"——
 * 那会让模型误以为子代理没说过话。
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {object | undefined}
 */
export function readProgress(ctx, sessionId) {
  try {
    const session = ctx.sessions?.get?.(sessionId);
    if (session === undefined) return undefined;
    return ctx.sessionProjections?.stateOf?.(session, PROJECTION_KEY);
  } catch {
    return undefined;
  }
}

/**
 * 子会话已卸载时，从持久化日志里补读终止原因。
 *
 * 投影状态存在 `registration.cells`（WeakMap，key 是 session 对象），
 * session 一卸载就跟着没了。而子代理"最后怎么结束的"恰恰只在卸载之后
 * 才需要——父级想知道它是正常干完，还是被 token 上限截断、报错、被中断。
 *
 * 所以走 sessionQuery：它按 sessionId 读，live 优先、否则读持久化日志，
 * 不依赖 session 还活着。只在内存路径读不到时才调用，正常路径零开销。
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {AbortSignal} [signal]
 * @returns {Promise<{kind: string, message?: string, code?: string, via?: string} | undefined>}
 */
export async function readStopReasonFromLog(ctx, sessionId, signal) {
  try {
    const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery;
    if (query === undefined || typeof query.listEvents !== 'function') return undefined;

    const events = await query.listEvents(sessionId, signal);
    if (!Array.isArray(events)) return undefined;

    // 取最后一个 turn/end：一个 session 可能有多个 turn，最后那个才是终点。
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event?.type !== 'turn/end') continue;
      const stop = extractStopReason(event.data?.reason);
      if (stop !== undefined) return stop;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
