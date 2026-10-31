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
