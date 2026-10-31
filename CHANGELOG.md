# Changelog

## 0.1.0 — 2026-10-31

首个版本。

### 新增

- `what_subagents_are_doing` 工具：回传每个子代理自己写的进度旁白
  （`assistant/message` 的 `text` block），而不只是 `running` / `inactive`
- 三种状态：`running` / `idle` / `possibly-stuck`（启发式），外加 `external`
- 分页：`limit`（1–50，默认 6）+ `before` 游标往回翻
- 增量提示：`narrationSinceLastLook` 告诉父代理自上次查看后新增几条
- 体积提示：`narrationTotal` / `narrationOmitted`，让模型自己决定要不要翻
- `scope: descendants` 查看整棵子树

### 实现要点

- 旁白走**投影**（`ctx.sessionProjections.register`），不走 `listEvents` 冷读——
  后者每次解压完整日志，父代理轮询会明显拖慢会话
- **零第三方依赖**：不 import 任何 `@deepseek-ai/*`，手写标准 JSON Schema。
  插件从 profile 外加载时裸包名解析不到 `app.asar` 内的 `dsh/node_modules`
- 工具名与上游 `list_agents` 完全不同，避免同名注册抛错与语义冲突
- 环形缓冲上限 200 条 / 子代理，单条截断 200 字符；`reasoning` block 一律排除

### 安全

- 纯只读：不写 session、不 `append` 事件、不调 `send_message` / `interrupt_agent`
- 目录读取失败时显式抛错，不返回空数组
- 会话不在内存时返回 `narration: null` + `note`，不假装"没说过话"
- 投影注册失败不致命，降级为 `progress unavailable`，绝不让 profile 起不来

### 验证

- 纯逻辑单测 33 项（`test/projection.test.mjs`）
- schema 校验 10 项，用 DSH 真实 `assertSupportedJsonSchema` / `validateJsonSchemaValue`
  （`test/schema.dsh.mjs`）
- 集成测试 24 项（`test/integration.dsh.mjs`）
