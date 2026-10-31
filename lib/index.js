/**
 * what-sub-agents-doing-now
 *
 * 让主代理看到每个子代理此刻在干什么。
 *
 * 设计要点：
 * - 纯只读：不写 session、不调 send_message/interrupt_agent、不改 ~/.dsh 配置。
 * - 不遮蔽上游工具：工具名与 list_agents 完全不同，避免两套语义冲突。
 * - 旁白走投影，不走冷读：官方规范禁止"缓存 miss 就打开完整日志"，
 *   且子会话日志解压后可达数 MB，每次轮询都读会明显拖慢会话。
 * - 零第三方依赖：只 import 自己的模块，不 import @deepseek-ai/*，
 *   否则插件从 profile 外加载时会 ERR_MODULE_NOT_FOUND。
 */

import { registerProjection } from './projection-registry.js';
import { registerTool } from './tool.js';

export const name = 'what-sub-agents-doing-now';

/**
 * 服务依赖。
 *
 * 全部是必需项：缺任何一个，插件应该显式不加载，
 * 而不是半残地跑起来返回错数据。
 *
 * 注意不要写成 `{required: [...], optional: [...]}`：cordis 的
 * `Inject.resolve` 只认「字符串数组」或「服务名 → 配置」映射，
 * 传对象会被当成需要名为 required 的服务，插件永远不会激活。
 *
 * 曾经想从 inject 里省掉可选的 `sessionQuery`（用 ctx.get 取），
 * 那个思路本身是对的——但那个服务在 profile 里根本不存在，
 * 相关功能已于 0.2.1 整体移除。见 CHANGELOG。
 */
export const inject = ['tools', 'subagents', 'agents', 'sessions', 'sessionProjections'];

/** 默认阈值：两分钟没动静标成 possibly-stuck。 */
const DEFAULT_STUCK_MS = 120_000;

/**
 * 插件入口。
 *
 * 配置形态刻意保持扁平（不引 schemastery）：
 * { stuckMs?: number }
 * 缺省时用 DEFAULT_STUCK_MS。
 *
 * @param {any} ctx
 * @param {object|undefined} config
 */
export function apply(ctx, config) {
  const configured = config?.stuckMs;
  const stuckMs = typeof configured === 'number'
    && Number.isFinite(configured)
    && configured >= 10_000
    && configured <= 3_600_000
    ? configured
    : DEFAULT_STUCK_MS;

  // 注册投影单元。失败不致命：工具会降级为 "progress unavailable"，
  // 但绝不能让整个 profile 起不来。
  const disposer = registerProjection(ctx);
  if (disposer === undefined) {
    ctx.logger?.warn?.(
      '[what-sub-agents-doing-now] projection unavailable; the tool will report '
      + 'progress as unavailable instead of failing the profile.',
    );
  }

  registerTool(ctx, { stuckMs });
}
