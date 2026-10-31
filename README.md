# what-sub-agents-doing-now

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.1-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**看得到每个子代理此刻在干什么。**

**See what each subagent is actually doing, right now.**

> 一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。
> 把子代理自己写的进度回传出来，而不只是 `running` / `inactive` 两个词。
>
> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
> surfaces the progress notes a subagent wrote itself — not just
> `running` / `inactive`.

---

## 这是什么 / What it is

派出去的子代理，你只能看到两个状态词。这个插件让你能看到它**说过的话**。

```js
// 以前 / before
child-a: inactive

// 现在 / now
child-a [running] — 做 2020 全国 III 卷文科数学
    42 steps, last tool: write, idle 0s
    • 核对第 11 题选项的系数（长图中这几行只显示根号）
    • 数学完成，共 23 题
```

一眼就知道：**它在核对选项系数，然后说做完了。**

装上就用，不用改配置、不用写提示词。

Install and it works — no config, no prompt changes.

---

## 问题 / The problem

用 `subagent` 派活，父代理只拿到一个二值状态：

```js
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
```

`inactive` 这一个词，同时覆盖四种完全不同的情况：

| 真实情况 | 父代理看到 |
|---|---|
| 干完了，结果给了 | `inactive` |
| 崩了 | `inactive` |
| 卡在半句话上 | `inactive` |
| 正在等它自己的子代理 | `inactive` |

分不出来，就只能反复轮询，或者瞎猜。

### DSH 官方没有做的事 / What DSH does not provide

进度信息**一直都在**——子代理每一步都会在 session 里留下自己的旁白。
问题不是数据不存在，而是**没有任何官方接口把它暴露出来**：

- **状态只有二值。** `agents.get(id).status` 只返回 `running` / `inactive`，
  没有任何"完成了没有""怎么结束的"字段。
- **进度没有接口。** session 里存着完整的旁白，但没有官方工具能把它读出来给
  父代理看。想拿到只能自己写插件。
- **结算通知不带结果。** 子代理结束时父会话会收到一条 `agent/inbox/spliced`，
  但它只带 `kind` / `form` / `summary` / `senderSessionId`，没有结构化结果字段。

所以父代理**只能**：要么轮询一个信息量极低的状态，要么干等。

**这个插件补的就是这一块。** 它不依赖上游修任何东西——数据本来就在那里，
它只是把已经存在的东西读出来、拼成父代理能直接用的样子。

The data was always there. There is simply no official interface that surfaces
it: status is binary, narration has no accessor, and the settlement notice
carries no structured result. This plugin fills that gap without depending on
any upstream change — it only reads what already exists.

### 上游已经报告过 / Upstream reports

这不是只有我们遇到的问题。DSH 官方仓库的 Discussions 里已经有三条记录，
截至 0.2.1-rc.5 仍无官方修复：

| Discussion | 内容 |
|---|---|
| [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) | 后台 `subagent` 停轮时不发完成通知，父代理只能轮询 `list_agents` |
| [#1202](https://github.com/deepseek-ai/deepseek-harness/discussions/1202) | 失败的子代理在 Web GUI 里仍显示为运行中，没有终态、也无法清除 |
| [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) | 生命周期交接契约缺失：父代理销毁时子代理被孤立 |

外加一条与工具命名相关的 [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642)
（Agent Teams 未禁用 subagent，导致 `list_agents` / `send_message` 找不到子代理），
本插件为此刻意不遮蔽上游工具名，详见
[`docs/how-it-works.md`](./docs/how-it-works.md#为什么不遮蔽-list_agents--upstream-list_agents-is-not-shadowed)。

**这些报告的共同点是：父代理拿不到子代理的真实状态。** 官方还没修，
所以我们自己先补上。

All three describe the same gap: the parent cannot see the child's real state.
Not fixed upstream, so this plugin fills it.

---

## 安装 / Install

走插件管理器（推荐，有事务回滚）：

Use the plugin manager (recommended, has transactional rollback):

```sh
dsh plugin --profile <profile> add what-sub-agents-doing-now
```

或者本地开发用 `link:`：

Or `link:` for local development:

```sh
dsh plugin --profile <profile> add link:/path/to/what-sub-agents-doing-now
```

### `file:` 还是 `link:` / `file:` or `link:`

**只有 `link:` 能热重载。** `file:` 是真实拷贝，`dsh-hmr` 监听不到它的变更，
改完代码必须重启 DSH。

`dsh-hmr` 的 `profileRoots()` 只覆盖 profile 目录和 `node_modules` 下的
**符号链接目标**。`file:` 安装是真目录，落在范围外。

**Only `link:` hot-reloads.** A `file:` install is a real copy outside the
watched range, so code edits require a restart.

---

## 用法 / Usage

模型侧只有一个新工具：

```js
what_subagents_are_doing({
  scope?,            // 'children'（默认）| 'descendants'
  limit?,            // 每个子代理回传几条旁白，1-50，默认 6
  before?,           // 只取 seq 严格小于此值的旁白，用于往回翻
  includeNarration?, // false 时只给元信息，省 token
})
```

> 包名是 `what-sub-agents-doing-now`，工具名是 `what_subagents_are_doing`。
> 工具名**不带** `_now`。
>
> The package is `what-sub-agents-doing-now`; the tool is
> `what_subagents_are_doing` — **no** `_now` suffix.

### 状态含义 / What each state means

| state | 什么情况 | 意思 |
|---|---|---|
| `running` | 子代理在跑 | 正在干活 |
| `idle` | 不在跑，空闲没超阈值 | 没在干活 |
| `possibly-stuck` | 不在跑，空闲超阈值 | **该看一眼了**，不代表坏了 |
| `external` | 跑在本机之外 | 读不到进度 |

> **`idle` 不等于干完了。** 它只说明当前没有 turn 在执行 —— 可能在等下一条消息，
> 也可能真结束了。真正的完成信号是那条结算通知。
>
> **`possibly-stuck` 不是故障判定。** 子代理正常等待下级时也会落到这个状态。
>
> **`idle` does not mean done.** The real completion signal is the settlement
> notice. **`possibly-stuck` is a heuristic nudge, not a failure verdict.**

### 往回翻 / Paging backwards

```
(showing 6 of 37; 31 older omitted — pass before=412 to see them)
```

`narrationTotal` 是它一共写了多少条，`narrationOmitted` 是这次没给多少条。
看到这个数，自己决定要不要往前翻。

同一个子代理看第二次，会带增量：

```
(+5 since you last looked)
```

### 已结束的子代理保留最后那句话 / Finished children keep their closing message

子代理一结束，session 就卸载了，进度读不到。但它的**收尾语**还在：

```
7dca3e4e [idle] — 分析 A 组 asar 结构
    note: session unloaded after settlement; the closing message is preserved below
    closing message, 240s ago:
      英语完成，共 60 题。
```

收尾语不在子会话里，而在父会话收到的那条结算通知里。插件把它截下来存住了。

一次会话最多记 50 条，同一子代理只留最新一条。

The closing text is not in the child's session — it is in the settlement notice
that lands in the *parent*. The plugin captures it there.

> 只捕获**插件运行期间**发生的结算。装之前就结束的子代理，仍然只有一行
> "progress unavailable"。
>
> Only settlements that happen while the plugin is running are captured.

---

## 什么时候该调 / When to call it

这是插件最容易失效的一环。

工具描述里只写「这是什么」不够——模型派完子代理就去干别的，直到结算通知才
回头。而通知**只在结束时才到**，真想了解进度的那一刻恰恰没有通知。

所以描述里写死了触发条件：

> Use this when you want to know how far a running subagent has gotten, or when
> one has been quiet longer than its task should take and you cannot tell
> whether it finished, failed, or is stuck.

反过来还有个坑：防轮询的措辞容易被读成「别查」。现在改成先允许一次查看，
再限制循环：

> One check when you are curious or suspicious is exactly what this is for.
> Do not poll in a loop: settlement already notifies you.

---

## Token 成本 / Token cost

### 静态：每轮都付

工具定义常驻 system prompt，装着就要付：

| 部分 | tokens |
|---|---|
| description | ~218 |
| parameters schema | ~179 |
| output schema | ~187 |
| name | ~6 |
| **合计** | **~590** |

（按紧凑 JSON 实测，保守估算。）

### 动态：每次调用

**插件不会主动推送。** 你不调，就只有上面那 ~590 tokens。

实测返回量：

| 场景 | tokens |
|---|---|
| 1 个子代理，`includeNarration: false` | ~32 |
| 1 个子代理，6 条短旁白 | ~137 |
| 3 个子代理，各 6 条 | ~387 |
| 5 个子代理，各 6 条 | ~645 |
| 1 个子代理，6 条满长度旁白 | ~1238 |

**每次返回都会累积进对话历史。** 调 20 次就是 20 份返回值，全留在 context 里。
控制成本靠**少调**，不是靠插件本身。

### 会不会爆炸 / Will it blow up

不会。内部状态是环形缓冲，每个子代理封顶 200 条 × 200 字符：

```
写第  100 条: 保留 100 条, 5222 B
写第 1000 条: 保留 200 条, 11053 B   ← 到这里就不再涨了
```

No. Ring buffer capped at 200 entries × 200 chars per child.

---

## 安全边界 / Safety boundaries

- **纯只读。** 不写 session、不发消息、不中断子代理、不改 `~/.dsh`
- **不遮蔽上游工具。** 工具名与 `list_agents` 完全不同
- **失败不影响 DSH 启动。** 投影注册失败只降级，不抛
- **读不到就说读不到。** 不会把「没有数据」伪装成「没说过话」

Read-only. Does not shadow upstream tools. A projection failure degrades instead
of crashing. When data is unavailable it says so rather than pretending.

---

## 已知限制 / Known limits

- **嵌套子代理没测过。** 只验证过一层（父 → 子）。`scope: 'descendants'` 转发给
  上游 `listDescendants()`，文档说会递归，但没在真实的孙代理树上验证过。
- **`image` 和 `reasoning` 按设计跳过。** 只发图片的 step 不产生旁白。
- **看不到终止原因。** 子代理是被截断、报错还是正常结束，本插件不区分。
  （试过，已回滚——原因见 [`docs/how-it-works.md`](./docs/how-it-works.md#终止原因试过又撤掉的功能--termination-reason-a-reverted-attempt)）
- **文件系统比插件更省事时，插件是冗余的。** 如果子代理的产出落盘就能看出进展
  （建文件、写长文档），`ls` 比调这个工具更划算。插件真正不可替代的场景是
  不落盘的工作——推理、分析、调研，或者反复改同一个文件。

Nested subagents untested. Image/reasoning blocks skipped by design. Termination
reason is not reported (attempted and reverted). When the filesystem already
reveals progress, this plugin is redundant.

---

## 故障排查 / Troubleshooting

### 装上但工具不出现

1. 确认插件已启用（插件管理页显示"运行中"）
2. **`file:` 安装改完代码必须重启 DSH**，它不热重载
3. 工具名是 `what_subagents_are_doing`，**没有 `_now`**

### 调用时报 `narration must be an array`

0.1.1 已修。升级即可。

### 子代理明明结束了，却显示 `progress unavailable`

正常。子代理结算后 session 会卸载，进度读不到。如果它是在插件运行期间结算的，
收尾语会显示在下面。装插件之前就结束的，只有这行提示。

---

## 开发 / Development

```sh
# 纯逻辑单测（不需要 DSH，51 项）
node test/projection.test.mjs

# schema 与集成测试（需要 DSH 的 Electron 运行时读 app.asar）
DSH_INSTALL=/path/to/dsh "<dsh>/DeepSeek Harness.exe" test/schema.dsh.mjs
DSH_INSTALL=/path/to/dsh "<dsh>/DeepSeek Harness.exe" test/integration.dsh.mjs
```

技术细节、设计取舍、以及**一次失败的功能尝试**，见
[`docs/how-it-works.md`](./docs/how-it-works.md)。

Implementation notes, design tradeoffs, and one reverted feature:
[`docs/how-it-works.md`](./docs/how-it-works.md).

---

## 背景 / Background

DSH 的 `agents.get(id).status` 只有 `running` / `inactive`。子代理的进度信息
其实一直在它的 session 里，只是没有任何工具把它暴露出来。

这个插件不依赖上游修任何东西。它只是把已经存在的数据读出来。

The progress was always in the session. Nothing exposed it. This plugin does not
depend on any upstream fix — it only reads data that already exists.

---

## License

MIT
