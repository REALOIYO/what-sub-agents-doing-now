# whatsubagentsdoingnow

让主代理看到每个子代理**此刻在干什么**。

上游 `list_agents` 的 `status` 只有 `running` / `inactive` 两个值，而 `inactive` 同时覆盖了
"干完了""崩了""卡在某句话上""在等下级"四种完全不同的情况。父代理区分不了，只能轮询。

本插件不改上游、不遮蔽上游工具，只加一个旁路入口：**把子代理自己写的进度旁白原样回传**。

```
child-a [running] — 做2020全国III卷文科数学
    42 steps, last tool: write, idle 0s
    • 核对第 11 题选项的系数（长图中这几行只显示根号）
    • 数学完成，共 23 题
```

不猜状态，直接给证据。

## 安装

```sh
dsh plugin --profile <name> add file:/绝对路径/whatsubagentsdoingnow
```

或走 DSH 的「设置 → 插件」管理器。

## 用法

模型侧只有一个工具：

```
what_subagents_are_doing({ scope?, limit?, before?, includeNarration? })
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `scope` | `children` | `children` 直接下级；`descendants` 整棵子树（带 parent 与 depth） |
| `limit` | `6` | 每个子代理回传多少条旁白（1–50） |
| `before` | — | 只取 seq 小于此值的旁白，用于往回翻 |
| `includeNarration` | `true` | `false` 时只给元信息，省 token |

### 状态的含义

| state | 判定 | 含义 |
|---|---|---|
| `running` | `agents.get(id).status === 'running'` | 正在干活 |
| `idle` | 非 running 且空闲未超阈值 | 没在干活（可能已完成，可能在等下级） |
| `possibly-stuck` | 非 running 且空闲超阈值 | **启发式**：该看一眼了，不代表它坏了 |
| `external` | `mode === 'external'` | 跑在本机之外，读不到进度 |

`possibly-stuck` 不是故障判定。子代理正常等待下级时也会落到这个状态。

### 往回翻

返回里带 `narrationTotal`（一共写了多少条）和 `narrationOmitted`（这次没给多少条）：

```
(showing 6 of 37; 31 older omitted — pass before=412 to see them)
```

模型看到这两个数，自己决定要不要用 `before` 往前翻。

如果同一个父代理看过同一个子代理两次，第二次会带 `narrationSinceLastLook`，
准确告诉它"自你上次查看后新增了几条"（按实际旁白条数算，不是 seq 差）。
这个游标只存在内存里，进程重启即失效——失效时字段省略，不影响正确性。

## 设计取舍

### 为什么旁白走投影，不走 `listEvents`

DSH 官方规范 `defensive-patterns/conversation-and-session.zh.md` 写死了：

> 冷读是最后手段。可用的缓存要先于原始日志被读取……缓存判断的 `else` 分支直接打开完整日志，即属违规。

`listEvents` 就是冷读：本机一个会话压缩后 2.4 MB、解压后 6.2 MB。父代理每调一次工具
都付这个代价，必然卡顿。所以这里注册投影单元，框架自己订阅 `session/event` 折叠，
值常驻内存。

### 为什么只取 `text` block

`assistant/message` 的 `content` 里有 `reasoning` 和 `text` 两种。实测单条 reasoning
可达 2000+ 字符，且它是思考过程而不是"子代理说了什么"。混进返回体会撑爆父代理的
上下文。所以只取 `type === 'text'`。

### 为什么不遮蔽 `list_agents`

两个原因：

1. `dsh-tools` 里同名注册直接抛 `tool "..." is already registered`；
2. 走 per-agent scope 遮蔽会让模型同时拿到两套语义冲突的工具
   （上游 #7642 已实证：调用报 `active teammate not found`）。

所以工具名完全不同。

### 为什么零第三方依赖

插件从 profile 外（工作区、`link:` 挂载）加载时，`import '@deepseek-ai/dsh-tools'`
会 `ERR_MODULE_NOT_FOUND`——裸包名解析不到 `app.asar` 内的 `dsh/node_modules`。
`ctx.tools.register` 本身只要求普通对象，`defineTool` 只是便捷包装，
所以这里直接手写标准 JSON Schema。

### 为什么 schema 不能写 `maxItems`

DSH 的 `assertSupportedJsonSchema` 只接受
`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` /
`enum` / `const` + 注解。长度上限由运行时环形缓冲保证（200 条），不写进 schema。

## 安全边界

- **纯只读**：不写 session、不 `append` 事件、不调 `send_message` / `interrupt_agent`
- **不改 `~/.dsh`**：无任何配置写入
- **失败显式化**：目录读取失败时抛错，**不返回空数组**——空数组会让模型以为
  "我没有子代理"，比报错更危险
- **会话不在内存时**：返回 `narration: null` + `note`，不假装"它没说过话"
- **旁白截断**：单条 200 字符、每个子代理最多存 200 条

## 配置

```yaml
- id: whatsubagentsdoingnow
  name: whatsubagentsdoingnow
  config:
    stuckMs: 120000   # 多久没动静标成 possibly-stuck，默认 120000
```

## 测试

```sh
# 纯逻辑单测（不需要 DSH）
node test/projection.test.mjs

# schema 与集成测试（需要 DSH 的 Electron 运行时读 app.asar）
"F:/dsh/DeepSeek Harness.exe" test/schema.dsh.mjs
"F:/dsh/DeepSeek Harness.exe" test/integration.dsh.mjs
```

## 已知限制

- `possibly-stuck` 是启发式，不是故障判定
- 子会话已从内存卸载时读不到旁白（返回显式 note）
- `narrationSinceLastLook` 的游标在进程重启后失效
- 只观察自己的下级，不跨父代理聚合
- 不修复上游"父代理消失时结算丢失"的问题（那需要改 asar）

## 相关上游讨论

- [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) — 生命周期交接契约缺失（四环全断）
- [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) — parked 状态无完成通知
- [#1202](https://github.com/deepseek-ai/deepseek-harness/discussions/1202) — 状态模型缺终态字段

截至 `0.2.1-rc.5`，上述问题均未修复（rc.2→rc.5 的 19 个提交里无一涉及 subagent）。

## License

MIT
