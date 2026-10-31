# what-sub-agents-doing-now

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.1-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**看到每个子代理此刻在干什么。**

**See what each subagent is actually doing, right now.**

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
> surfaces the progress notes a subagent wrote itself — not just `running` / `inactive`.
>
> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：
> 把子代理自己写的进度旁白回传出来，而不只是 `running` / `inactive` 两个状态。

---

## 问题 / The problem

用 `subagent` 派出去的子代理，主代理只能看到一个二值状态：

When you delegate work with `subagent`, the parent agent only sees a binary status:

```js
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
```

`inactive` 这一个词，同时覆盖了四种完全不同的情况：

That single word `inactive` covers four completely different situations:

| 真实情况 / What happened | 父代理看到 / Parent sees |
|---|---|
| 干完了，结果已交付 / Finished, result delivered | `inactive` |
| 崩了 / Crashed | `inactive` |
| 卡在某句话上不动了 / Stuck mid-sentence | `inactive` |
| 正在等它自己的子代理回报 / Waiting on its own children | `inactive` |

父代理区分不了，只能反复轮询，或者干脆瞎猜。

The parent cannot tell them apart. It either polls in a loop or guesses.

## 解决 / The fix

**不猜状态，直接回传子代理自己说的话。**

**Stop guessing. Show what the child wrote.**

子代理每一步都会在会话里留下进度旁白。本插件把这些旁白读出来给父代理看：

Every subagent leaves progress notes in its session as it works. This plugin reads
those notes and hands them back to the parent:

```
child-a [running] — 做2020全国III卷文科数学 / verify plugin compatibility
    42 steps, last tool: write, idle 0s
    • 核对第 11 题选项的系数（长图中这几行只显示根号）
    • 数学完成，共 23 题
```

一眼就知道：**它在核对选项系数，然后说做完了**。这是任何状态枚举都给不出的信息。

Now you know: **it was checking option coefficients, then reported done.** No status
enum can express that.

## 安装 / Install

```sh
dsh plugin --profile <profile> add file:/path/to/what-sub-agents-doing-now
```

或者走 DSH 的「设置 → 插件」管理器。装完需要重启 DSH。

Or use the plugin manager in DSH settings. Restart DSH afterwards.

### `file:` 还是 `link:` / `file:` or `link:`

两者都能装，但热重载行为完全不同：

Both work, but hot-reload behaviour differs completely:

| 协议 / Protocol | 形态 / Form | 改代码后 / After editing code |
|---|---|---|
| `file:` | pnpm 真实拷贝 / real copy | **必须重启** / **restart required** |
| `link:` | 目录符号链接 / directory symlink | 自动热重载 / hot-reloads automatically |

原因是 DSH 的 HMR 靠 `dsh-hmr` 的 `profileRoots()` 决定哪些已加载模块属于当前
profile —— 它只挑 `node_modules` 里**符号链接**的目标加进观察范围。
`file:` 装出来的是真实目录，不在那个范围里，改了也不会重新加载。

DSH's HMR relies on `profileRoots()` in `dsh-hmr` to decide which loaded modules
belong to the profile — it only picks up the **symlink targets** under
`node_modules`. A `file:` install is a real directory, so it falls outside that
range and edits never trigger a reload.

想开发时热重载 / For hot-reload while developing:

```sh
dsh plugin --profile <profile> add link:/path/to/what-sub-agents-doing-now
```

> 注意 `link:` 的代价：源目录被移动或删除后，该 entry 加载失败。按上游逻辑
> 它只会打 warning，不会让 DSH 起不来。

## 用法 / Usage

模型侧只有一个新工具 / One new tool on the model side:

```js
what_subagents_are_doing({
  scope?,            // 'children'（默认）| 'descendants'
  limit?,            // 每个子代理回传几条旁白，1-50，默认 6
  before?,           // 只取 seq 小于此值的旁白，用于往回翻
  includeNarration?, // false 时只给元信息，省 token
})
```

### 什么时候该调 / When to call it

这是插件最容易失效的一环，值得单独说。

This is where a monitoring plugin usually fails, so it gets its own section.

工具描述里只写「这是什么」是不够的：模型派完子代理就去干别的活，直到结算通知
才回头，中途没有任何理由主动来查。而通知**只在子代理结束时才到**，真想了解
进度的那一刻恰恰没有通知。片段描述必须显式写出触发条件，否则工具会长期闲置。

Describing *what it does* is not enough. After delegating, a model moves on to
other work and only looks back when the settlement notice arrives — but that
notice **only comes at the end**. The moment it actually wants progress is
exactly the moment no notice exists. The description therefore spells out the
trigger:

> Use this when you want to know how far a running subagent has gotten, or when
> one has been quiet longer than its task should take and you cannot tell
> whether it finished, failed, or is stuck.

反过来的坑是防轮询的措辞被读成「别查」。旧版写的是无条件的
`Do not poll in a loop: you are notified when a subagent settles.`，
容易被理解成「等通知就行」，正好把中途查看的动机堵死。现在改成先允许一次
「好奇或怀疑时的查看」，再限制循环轮询：

The opposite trap is an anti-polling line read as "never look". The old wording
was an unconditional `Do not poll in a loop: you are notified when a subagent
settles.`, easily taken as "just wait for the notice" — killing the very
behaviour the plugin exists for. It now permits a single check when curious or
suspicious, and only forbids looping:

> One check when you are curious or suspicious is exactly what this is for.
> Do not poll in a loop: settlement already notifies you.

### 状态含义 / What each state means

| state | 判定 / Rule | 含义 / Meaning |
|---|---|---|
| `running` | 子代理状态为 running | 正在干活 / Actively working |
| `idle` | 非 running 且空闲未超阈值 | 没在干活，可能已完成或在等下级 / Not working |
| `possibly-stuck` | 非 running 且空闲超阈值 | **启发式提示**：该看一眼了，不代表它坏了 / **Heuristic nudge**, not proof of failure |
| `external` | 子代理跑在本机之外 | 读不到进度 / Progress unavailable |

> `possibly-stuck` 不是故障判定。子代理正常等待下级时也会落到这个状态。
>
> `possibly-stuck` is not a failure verdict. A child legitimately waiting on its
> own descendants lands here too.

### 往回翻 / Paging backwards

返回里带两个计数 / Every row carries two counters:

```
(showing 6 of 37; 31 older omitted — pass before=412 to see them)
```

`narrationTotal` 是它一共写了多少条，`narrationOmitted` 是这次没给多少条。
看到这个数，父代理自己决定要不要往前翻。

`narrationTotal` is how many notes it wrote in all; `narrationOmitted` is how many
this response left out. The model sees the gap and decides whether to page back.

如果同一个父代理看过同一个子代理两次，第二次会带 `narrationSinceLastLook`：

Look twice and the second call adds `narrationSinceLastLook`:

```
(+5 since you last looked)
```

准确告诉它「自你上次查看后新增了几条」。

Exact count of notes added since the previous look.

### 已结束的子代理会保留收尾语 / Finished children keep their closing message

子代理结束后 session 会被卸载，旁白就读不到了。但**结算通知还留在父会话里**，
带着它最后说的话，所以本插件把它捞出来：

A finished child's session is unloaded, so its narration is gone. The **settlement
notice stays in the parent session** carrying the child's closing text, so this
plugin recovers it:

```
7dca3e4e [idle] — 分析 A 组 asar 结构
    note: session unloaded after settlement; the closing message is preserved below
    closing message, 240s ago:
      英语完成，共 60 题。
```

这样回溯时至少知道「它干完了，结论是这个」，而不是只剩一句「读不到」。

Now a finished child still tells you what it concluded, instead of collapsing
into a bare "unreadable".

> 结算记录只有**在插件运行期间发生的结算**才会被收集。装插件之前就已结束的
> 子代理没有这条记录，仍显示 `session not resident in memory`。
>
> Only settlements that happen **while the plugin is running** get collected.
> Children that finished before installation still show the bare unavailable note.

## 配置 / Configuration

```yaml
- id: what-sub-agents-doing-now
  name: what-sub-agents-doing-now
  config:
    stuckMs: 120000   # 多久没动静标成 possibly-stuck，默认 120000（2 分钟）
```

## Token 成本 / Token cost

分两部分，性质完全不同。

Two separate parts with very different characteristics.

### 静态成本：每轮都付 / Static: paid every turn

工具定义常驻 system prompt，只要插件装着就要付：

The tool definition sits in the system prompt for as long as the plugin is
installed:

| 部分 / Part | tokens |
|---|---|
| description | ~201 |
| parameters schema | ~179 |
| output schema | ~187 |
| name | ~6 |
| **合计 / Total** | **~573** |

（按紧凑 JSON 实测；中文按 1 字 ≈ 1 token、其余 4 字符 ≈ 1 token 保守估算。）

Measured on the compact JSON actually sent; conservative estimate.

schema 里不写字段级描述，语义都在 `description` 里讲一次 —— 静态成本是每轮
都付的，重复描述没有意义。

Field-level docs are deliberately kept out of the schema; semantics are explained
once in `description`. Static cost is paid every turn, so duplication is waste.

### 动态成本：每次调用 / Dynamic: per call

**插件不会主动推送。** 你不调，context 里就只有上面那 ~573 tokens。
调一次，返回那一刻的快照。

**The plugin never pushes.** If you never call it, the only cost is the ~573
tokens above. Each call returns a snapshot of that moment.

实测返回量 / Measured return sizes:

| 场景 / Scenario | tokens |
|---|---|
| 1 个子代理，`includeNarration: false` | ~32 |
| 1 个子代理，6 条短旁白 | ~137 |
| 3 个子代理，各 6 条短旁白 | ~387 |
| 5 个子代理，各 6 条短旁白 | ~645 |
| 1 个子代理，6 条满长度旁白（200 字符上限） | ~1238 |

**关键：每次返回都会累积进对话历史。** 调 20 次就是 20 份返回，全部留在
context 里。控制成本靠减少调用次数，不是靠插件本身。

**Important: every return accumulates in the conversation history.** Twenty calls
leave twenty responses in context. Cost control comes from calling less often,
not from the plugin.

省 token 的三个办法 / Three ways to spend less:

1. `includeNarration: false` —— 只要状态，不要旁白（32 vs 137）
2. 调小 `limit` —— `limit: 2` 比默认 6 少三分之二
3. **少调** —— 一次看清胜过五次分别看

### 会不会爆炸 / Will it blow up

不会。插件内部状态是环形缓冲，每个子代理封顶 200 条 × 200 字符：

No. Internal state is a ring buffer capped at 200 entries × 200 characters per
subagent:

```
写到第  100 条时: 保留 100 条, 状态  5222 B
写到第  500 条时: 保留 200 条, 状态 11053 B
写到第 1000 条时: 保留 200 条, 状态 11053 B   ← 封顶，不再增长
```

**但这个上限管的是插件内部状态，不是返回给模型的内容。** 返回累积到 context
是调用次数的函数，由调用方控制。

**That cap bounds internal state, not what reaches the model.** Accumulation in
context is a function of how often you call.

## 设计取舍 / Design notes

### 旁白走投影，不走全量读日志 / Narration comes from a projection, not a full log read

DSH 官方规范（`defensive-patterns/conversation-and-session`）写死：

DSH's own defensive-patterns guide is explicit:

> 冷读是最后手段。可用的缓存要先于原始日志被读取……缓存判断的 `else`
> 分支直接打开完整日志，即属违规。
>
> Cold reads are the last resort. A cache miss that falls through to opening the
> complete log is a violation.

子会话日志解压后可达数 MB。父代理每调一次工具都全量读一遍，必然卡顿。
所以这里注册**投影单元**，框架自己订阅事件并折叠，值常驻内存。

A child session log can exceed several MB once decompressed. Reading it on every
poll would make long sessions crawl. This plugin registers a **projection unit**
instead: the framework subscribes to events and folds them, keeping the value in
memory.

### 只取 `text` block / Only `text` blocks, never `reasoning`

`assistant/message` 的 `content` 里有 `reasoning` 和 `text` 两种。实测单条
reasoning 可达 2000+ 字符，而且它是思考过程，不是「子代理说了什么」。
混进返回体会撑爆父代理的上下文。所以只取 `type === 'text'`。

`assistant/message` content carries both. A single reasoning block can run past
2000 characters, and it is internal deliberation rather than something the child
*says*. Including it would blow up the parent's context. Only `type === 'text'`
is kept.

### 不遮蔽上游 `list_agents` / Upstream `list_agents` is not shadowed

两个原因 / Two reasons:

1. `dsh-tools` 里同名注册直接抛 `tool "..." is already registered`
2. 走 per-agent scope 遮蔽会让模型同时拿到两套语义冲突的工具
   （上游 [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642)
   已实证：调用报 `active teammate not found`）

So this tool's name is entirely different.

### 零第三方依赖 / Zero third-party dependencies

插件从 profile 外（工作区、`link:` 挂载）加载时，`import '@deepseek-ai/dsh-tools'`
会 `ERR_MODULE_NOT_FOUND` —— 裸包名解析不到 `app.asar` 内的 `dsh/node_modules`。

When a plugin loads from outside the profile, `import '@deepseek-ai/dsh-tools'`
fails with `ERR_MODULE_NOT_FOUND` — bare specifiers resolve against
`dsh/node_modules` *inside* `app.asar`.

`ctx.tools.register` 本身只要求普通对象，`defineTool` 只是便捷包装。
所以这里直接手写标准 JSON Schema，不引任何外部包。

`ctx.tools.register` only needs a plain object; `defineTool` is a convenience
wrapper. So this plugin hand-writes standard JSON Schema and imports nothing.

### schema 不能写 `maxItems` / `maxItems` is not allowed

DSH 的 `assertSupportedJsonSchema` 只接受
`type` / `oneOf` / `properties` / `required` / `additionalProperties` /
`items` / `enum` / `const` + 注解。长度上限由运行时环形缓冲保证（200 条），
不写进 schema。

DSH's `assertSupportedJsonSchema` accepts only those keywords. Size limits are
enforced by the runtime ring buffer (200 entries) rather than the schema.

## 安全边界 / Safety boundaries

- **纯只读**：不写 session、不 `append` 事件、不调 `send_message` / `interrupt_agent`
  / **Read-only**: writes no session events, never calls `send_message` /
  `interrupt_agent`
- **不改 `~/.dsh`**：无任何配置写入 / **No `~/.dsh` writes**
- **失败显式化**：目录读取失败时抛错，不返回空数组（空数组会让模型以为
  「我没有子代理」，比报错更危险）/ **Failures are explicit**: catalog errors
  throw rather than returning `[]`
- **会话不在内存时**：返回 `narration: []` + `note` 说明原因，不假装「它没说过话」
  / **Session gone**: returns `narration: []` plus a `note`, never pretends the
  child said nothing
- **体积有界**：单条旁白截断 200 字符，每个子代理最多存 200 条
  / **Bounded size**: 200 characters per note, 200 notes per subagent

## 已知限制 / Known limits

- **嵌套子代理未经实测** / **Nested subagents untested**

  目前只在一层委派下验证过（主代理 → 子代理）。子代理再派孙代理的情况没有实测，
  因为它在实际使用中很少见。

  `scope: 'descendants'` 走的是上游 `listDescendants()`，会递归读取每个子级的
  目录，理论上支持多层（上游文档说以稳定前序递归、保留每层的事件顺序）。但
  **这条路径我没有跑过真实用例**，不排除孙代理的旁白读不到、或者状态判定不准。

  如果你需要嵌套场景，建议先用 `scope: 'descendants'` 小范围验证一次再依赖它。

  Only one level of delegation (parent → child) has been verified. A child that
  spawns its own grandchildren is **not tested**, because it is rare in practice.

  `scope: 'descendants'` delegates to upstream `listDescendants()`, which recurses
  through each child's catalog and is documented to support multiple levels. That
  path has **not** been exercised against a real grandchild tree here, so
  grandchild narration or state classification may misbehave. Verify with a small
  case before relying on it.

- `possibly-stuck` 是启发式，不是故障判定 / heuristic, not a failure verdict
- 子代理结束后 session 会从内存卸载，此时读不到旁白（返回显式 `note`）
  / a finished child's session is unloaded; narration is unavailable then
- `narrationSinceLastLook` 的游标在 DSH 重启后失效，失效时该字段省略
  / the cursor dies with a DSH restart; the field is omitted afterwards
- 只观察自己的下级，不跨父代理聚合 / observes direct descendants only
- **纯文本旁白**：只取 `text` block，`image` / `reasoning` 都跳过（图不是进度说明，
  思考过程会撑爆 context）。若子代理某一步只发了图片，那条不会出现在旁白里
  / **text only**: `image` and `reasoning` blocks are skipped by design
- 不修复上游「父代理消失时结算丢失」的问题（那需要改 `app.asar`）
  / does **not** fix upstream's "settlement lost when the parent vanished"

## 故障排查 / Troubleshooting

### 装上但工具不出现 / Installed but the tool does not appear

```sh
dsh plugin --profile <profile> list | grep what-sub-agents-doing-now
```

确认在列表里后重启 DSH。如果重启后仍看不到，看启动时的 stderr 是否有
`skipping profile bundle`。

Confirm it is listed, then restart DSH. If still missing, check startup stderr for
`skipping profile bundle`.

### 调用时报 `narration must be an array`

已修复（0.1.1）。旧版在子代理结束后返回 `null` 而不是空数组，被 DSH 输出校验拒绝。

Fixed in 0.1.1. Older versions returned `null` instead of an empty array once the
child settled, which DSH's output validation rejects.

## 开发 / Development

```sh
# 纯逻辑单测（不需要 DSH）/ Pure-logic unit tests (no DSH needed)
node test/projection.test.mjs

# schema 与集成测试（需要 DSH 的 Electron 运行时读 app.asar）
# Schema and integration tests (need DSH's Electron runtime for app.asar)
"<DSH install dir>/DeepSeek Harness.exe" test/schema.dsh.mjs <installDir>
"<DSH install dir>/DeepSeek Harness.exe" test/integration.dsh.mjs <installDir>
```

环境变量 `DSH_INSTALL` 也可以代替 `installDir` 参数。
The `DSH_INSTALL` environment variable can replace the `installDir` argument.

## 背景 / Background

相关上游讨论（截至 0.2.1-rc.5 均未修复，官方回复数为 0）：

Related upstream discussions (all still open as of 0.2.1-rc.5, zero official replies):

| 编号 / # | 内容 / Topic |
|---|---|
| [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) | 生命周期交接契约缺失，父代理退出后子代理成孤儿 / Lifecycle handoff contract missing — children orphaned when the parent exits |
| [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) | parked 状态没有完成通知，父代理只能轮询 / Parked state gets no completion notice; the parent must poll |
| [#1202](https://github.com/deepseek-ai/deepseek-harness/discussions/1202) | 状态模型缺「终态结局」字段，三个界面各猜各的 / No terminal-outcome field; three surfaces guess differently |

另见 [`docs/send-message-shadowing.md`](docs/send-message-shadowing.md)：为什么
`send_message` 联系不上子代理（Agent Teams 遮蔽），以及自补方案的可行性分析。

See also [`docs/send-message-shadowing.md`](docs/send-message-shadowing.md) for why
`send_message` cannot reach subagents (Agent Teams shadowing) and whether a
workaround is worth building.

## License

[MIT](LICENSE)
