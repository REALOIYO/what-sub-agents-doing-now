# whatsubagentsdoingnow

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.1-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**让主代理看到每个子代理此刻在干什么。**

> A DeepSeek Harness plugin that shows what each subagent is actually doing —
> not just `running` / `inactive`, but the progress notes the child wrote itself.

---

## 问题

用 `subagent` 派出去的子代理，主代理只能看到一个二值状态：

```js
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
```

`inactive` 这一个词，同时覆盖了四种完全不同的情况：

| 真实情况 | 父代理看到 |
|---|---|
| 干完了，结果已交付 | `inactive` |
| 崩了 | `inactive` |
| 卡在某句话上不动了 | `inactive` |
| 正在等它自己的子代理回报 | `inactive` |

父代理区分不了，只能反复轮询，或者干脆瞎猜。

## 解决

**不猜状态，直接回传子代理自己说的话。**

子代理每一步都会在会话里留下进度旁白。本插件把这些旁白读出来给父代理看：

```
child-a [running] — 做2020全国III卷文科数学
    42 steps, last tool: write, idle 0s
    • 核对第 11 题选项的系数（长图中这几行只显示根号）
    • 数学完成，共 23 题
```

一眼就知道：**它在核对选项系数，然后说做完了**。这是任何状态枚举都给不出的信息。

## 安装

```sh
dsh plugin --profile <profile> add file:/path/to/whatsubagentsdoingnow
```

或者走 DSH 的「设置 → 插件」管理器。

装完需要重启 DSH。

## 用法

模型侧只有一个新工具：

```js
what_subagents_are_doing({
  scope?,            // 'children'（默认）| 'descendants'
  limit?,            // 每个子代理回传几条旁白，1-50，默认 6
  before?,           // 只取 seq 小于此值的旁白，用于往回翻
  includeNarration?, // false 时只给元信息，省 token
})
```

### 状态含义

| state | 判定 | 含义 |
|---|---|---|
| `running` | 子代理状态为 running | 正在干活 |
| `idle` | 非 running 且空闲未超阈值 | 没在干活（可能已完成，可能在等下级） |
| `possibly-stuck` | 非 running 且空闲超阈值 | **启发式提示**：该看一眼了，不代表它坏了 |
| `external` | 子代理跑在本机之外 | 读不到进度 |

> `possibly-stuck` 不是故障判定。子代理正常等待下级时也会落到这个状态。

### 往回翻

返回里带两个计数：

```
(showing 6 of 37; 31 older omitted — pass before=412 to see them)
```

`narrationTotal` 是它一共写了多少条，`narrationOmitted` 是这次没给多少条。
看到这个数，父代理自己决定要不要往前翻。

如果同一个父代理看过同一个子代理两次，第二次会带 `narrationSinceLastLook`：

```
(+5 since you last looked)
```

准确告诉它「自你上次查看后新增了几条」。

## 配置

```yaml
- id: whatsubagentsdoingnow
  name: whatsubagentsdoingnow
  config:
    stuckMs: 120000   # 多久没动静标成 possibly-stuck，默认 120000（2 分钟）
```

## 设计取舍

### 为什么旁白走投影，不走全量读日志

DSH 官方规范（`defensive-patterns/conversation-and-session`）写死：

> 冷读是最后手段。可用的缓存要先于原始日志被读取……缓存判断的 `else`
> 分支直接打开完整日志，即属违规。

子会话日志解压后可达数 MB。父代理每调一次工具都全量读一遍，必然卡顿。
所以这里注册**投影单元**，框架自己订阅事件并折叠，值常驻内存。

### 为什么只取 `text` block

`assistant/message` 的 `content` 里有 `reasoning` 和 `text` 两种。
实测单条 reasoning 可达 2000+ 字符，而且它是思考过程，不是「子代理说了什么」。
混进返回体会撑爆父代理的上下文。所以只取 `type === 'text'`。

### 为什么不遮蔽上游的 `list_agents`

两个原因：

1. `dsh-tools` 里同名注册直接抛 `tool "..." is already registered`
2. 走 per-agent scope 遮蔽会让模型同时拿到两套语义冲突的工具
   （上游 [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642)
   已实证：调用报 `active teammate not found`）

所以工具名完全不同。

### 为什么零第三方依赖

插件从 profile 外（工作区、`link:` 挂载）加载时，`import '@deepseek-ai/dsh-tools'`
会 `ERR_MODULE_NOT_FOUND` —— 裸包名解析不到 `app.asar` 内的 `dsh/node_modules`。

`ctx.tools.register` 本身只要求普通对象，`defineTool` 只是便捷包装。
所以这里直接手写标准 JSON Schema，不引任何外部包。

### 为什么 schema 不能写 `maxItems`

DSH 的 `assertSupportedJsonSchema` 只接受
`type` / `oneOf` / `properties` / `required` / `additionalProperties` /
`items` / `enum` / `const` + 注解。

长度上限由运行时环形缓冲保证（200 条），不写进 schema。

## 安全边界

- **纯只读**：不写 session、不 `append` 事件、不调 `send_message` / `interrupt_agent`
- **不改 `~/.dsh`**：无任何配置写入
- **失败显式化**：目录读取失败时抛错，**不返回空数组**
  （空数组会让模型以为「我没有子代理」，比报错更危险）
- **会话不在内存时**：返回 `narration: []` + `note` 说明原因，不假装「它没说过话」
- **体积有界**：单条旁白截断 200 字符，每个子代理最多存 200 条

## 已知限制

- `possibly-stuck` 是启发式，不是故障判定
- 子代理结束后 session 会从内存卸载，此时读不到旁白（返回显式 `note`）
- `narrationSinceLastLook` 的游标在 DSH 重启后失效，失效时该字段省略
- 只观察自己的下级，不跨父代理聚合
- 不修复上游「父代理消失时结算丢失」的问题（那需要改 `app.asar`）

## 故障排查

### 装上但工具不出现

```sh
dsh plugin --profile <profile> list | grep whatsubagentsdoingnow
```

确认在列表里后重启 DSH。如果重启后仍看不到，看启动时的 stderr 是否有
`skipping profile bundle`。

### 调用时报 `narration must be an array`

已修复（0.1.1）。如果你用的是旧版本，升级即可 —— 旧版在子代理结束后
返回 `null` 而不是空数组，被 DSH 输出校验拒绝。

## 开发

```sh
# 纯逻辑单测（不需要 DSH）
node test/projection.test.mjs

# schema 与集成测试（需要 DSH 的 Electron 运行时读 app.asar）
"<DSH 安装目录>/DeepSeek Harness.exe" test/schema.dsh.mjs <installDir>
"<DSH 安装目录>/DeepSeek Harness.exe" test/integration.dsh.mjs <installDir>
```

环境变量 `DSH_INSTALL` 也可以代替 `installDir` 参数。

## 背景

相关上游讨论（截至 0.2.1-rc.5 均未修复，官方回复数为 0）：

| 编号 | 内容 |
|---|---|
| [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) | 生命周期交接契约缺失，父代理退出后子代理成孤儿 |
| [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) | parked 状态没有完成通知，父代理只能轮询 |
| [#1202](https://github.com/deepseek-ai/deepseek-harness/discussions/1202) | 状态模型缺「终态结局」字段，三个界面各猜各的 |

另见 [`docs/send-message-shadowing.md`](docs/send-message-shadowing.md)：为什么
`send_message` 联系不上子代理（Agent Teams 遮蔽），以及自补方案的可行性分析。

## License

[MIT](LICENSE)
