# 技术实现 / Technical implementation

> 这份文档解释**为什么这么写**。README 讲的是插件能干什么、怎么用。
> This document explains **why the code is shaped this way**. The README covers
> what the plugin does and how to use it.

目录 / Contents

- [整体结构](#整体结构--architecture)
- [旁白从哪来：投影而非冷读](#旁白从哪来投影而非冷读--narration-comes-from-a-projection-not-a-cold-log-read)
- [为什么只取 text block](#为什么只取-text-block--only-text-blocks-never-reasoning)
- [收尾语为什么从父会话捞](#收尾语为什么从父会话捞--why-the-closing-message-comes-from-the-parent-session)
- [终止原因：试过又撤掉的功能](#终止原因试过又撤掉的功能--termination-reason-a-reverted-attempt)
- [为什么不遮蔽 list_agents](#为什么不遮蔽-list_agents--upstream-list_agents-is-not-shadowed)
- [零第三方依赖的原因](#零第三方依赖的原因--why-zero-third-party-dependencies)
- [schema 关键字子集](#schema-关键字子集--the-supported-json-schema-subset)
- [stateVersion 的语义](#stateversion-的语义--what-stateversion-means)
- [失效模式清单](#失效模式清单--failure-modes)

---

## 整体结构 / Architecture

六个文件，职责单一，只有 `index.js` 碰 DSH 的 ctx：

| 文件 | 职责 | 能否脱离 DSH 测试 |
|---|---|---|
| `lib/projection.js` | 纯函数：把 session 事件折成状态 | ✅ 可以 |
| `lib/paginate.js` | 纯逻辑：分页、游标、状态判定 | ✅ 可以 |
| `lib/collect.js` | 编排：目录 + 投影 → 可读的行 | 部分（依赖 ctx 形状） |
| `lib/projection-registry.js` | 注册投影、读取状态 | 否 |
| `lib/tool.js` | 注册工具、渲染文本 | 否 |
| `lib/index.js` | 插件入口、配置校验 | 否 |

**设计原则：把能做成纯函数的都做成纯函数。** 因为纯函数可以用 `node` 直接跑，
不需要启动 Electron、不需要读 182 MB 的 `app.asar`。这让 51 项断言能在
1 秒内跑完，而不是每改一行都重启一次 DSH。

Six files with one responsibility each. Only `index.js` touches DSH's `ctx`.
Everything that could be a pure function is one, so tests run in a second under
plain `node` instead of requiring an Electron boot.

---

## 旁白从哪来：投影而非冷读 / Narration comes from a projection, not a cold log read

这是整个插件最重要的一个决定。

### 问题 / The problem

子代理说的话记在它自己的 session 日志里。日志落盘时是**多帧 zstd 压缩**的
（`session.v4.jsonl.zstd`），解压后可达数 MB。

最直觉的做法是"父代理每次调用工具，就去读子代理的日志文件"。这是**冷读**，
有两个问题：

1. **慢。** 每次调用都要解压整个文件、逐行 JSON.parse、再过滤。
   父代理如果看 5 个子代理，就是 5 次全量解压。
2. **违规。** DSH 官方规范（`defensive-patterns/conversation-and-session.zh.md`）
   把"缓存 miss 就直接打开完整日志"明确列为最后手段。缓存判断的 else 分支
   直接开日志属于违规。

The child's words live in its session log, stored as multi-frame zstd that can
decompress to megabytes. Reading that file on every tool call is slow, and the
official guidance explicitly treats "cache miss → open the full log" as a last
resort.

### 解法 / The solution

注册一个 **session projection**（投影单元）。框架会把每个已提交事件喂给
`apply(state, event)`，状态常驻内存。父代理调用时只是读一个内存对象。

Register a session projection. The framework feeds every committed event through
`apply(state, event)` and keeps the state in memory, so a tool call reads a plain
object.

```js
ctx.sessionProjections.register({
  key: PROJECTION_KEY,
  stateSchema: STATE_SCHEMA,
  stateVersion: STATE_VERSION,
  init: initState,
  apply: applyEvent,
  // 不传 wire：host-only 单元，不进客户端快照
});
```

### 硬约束 / Hard constraints on `apply`

违反任何一条，框架的增量驱动会退化成全量重算：

- **必须是纯函数**：禁止网络、文件 I/O、`Date.now()`
- **时间戳一律取 `event.time`**，不读系统时钟
- **不改变入参**；未变化时**返回原引用**（框架用 `Object.is` 判断是否需要通知）

最后一条容易被忽略。看 `applyEvent` 的每个分支：

```js
if (type === 'step/start' || ...) {
  if (time === state.lastAt && seq === state.lastSeq) return state;  // ← 原引用
  return { ...state, lastAt: time, lastSeq: seq };
}
return state;  // ← 不认识的事件也返回原引用
```

Break any of these and the framework's incremental drive degrades to full
recomputation. Returning the same reference when nothing changed is the subtle
one — it is what lets the framework use `Object.is` to decide whether to notify.

### 代价 / The cost

投影单元会跑在**每一个** session 上，包括父会话。这是有意的——正是靠这一点，
它才能顺手截获父会话里的结算通知（见下一节）。

The unit runs against every session, parent included. That is deliberate: it is
how the settlement notices get captured.

---

## 为什么只取 text block / Only `text` blocks, never `reasoning`

`assistant/message` 的 `content` 是 block 数组，实测类型有：

| type | 是什么 | 要不要 |
|---|---|---|
| `text` | 说给用户/父代理的话 | ✅ 这就是旁白 |
| `reasoning` | 内心推理 | ❌ 不要 |
| `tool-call` | 工具调用（`arguments` 是 JSON **字符串**） | ❌ 另算步数 |
| `image` | 图片（带 `attachment`） | ❌ 不要 |

`reasoning` 绝对不能要。它可能极长、可能包含自我怀疑和反复推翻，而且
**它本来就不是说给别人听的**。把它塞进父代理的 context 是灾难。

`image` 跳过之后有个副作用：一个只发图片的 step 不产生旁白。这算已知限制，
写进了 README。

`reasoning` is excluded because it can be enormous, full of second-guessing, and
was never meant for an audience. Skipping `image` has a side effect: a step that
only emits an image produces no narration entry.

---

## 收尾语为什么从父会话捞 / Why the closing message comes from the parent session

### 问题 / The problem

子代理一结算，它的 session 就从内存卸载了。投影状态存在
`registration.cells`（一个 `WeakMap`，key 是 **session 对象**），
session 一卸载，状态跟着消失。

于是已结束的子代理只剩一行：

```
progress unavailable: session not resident in memory
```

这对回溯毫无价值——而"回溯"恰恰是最常见的需求。

### 关键观察 / The key observation

子代理的收尾语**并没有消失**。它以另一种形式留在**父会话**里：

```js
// 父会话里的一条 agent/inbox/spliced 事件
inserted: [{
  content: [
    { type: 'text', text: 'Background subagent <id> finished and ...' },
    { type: 'text', text: 'Its closing message:' },
    { type: 'text', text: '英语完成，共 60 题。' },      // ← 收尾语在这
  ],
  source: {
    kind: 'subagent-settled',
    senderSessionId: '<childId>',          // ← 这是哪个子代理
    summary: '...',
    form: 'notice',
  },
}]
```

而投影单元**对每个 session 都会跑**，所以它同时在父会话上运转，能顺手截获
这条事件。

### 实现 / Implementation

`extractSettlement(message)` 认两个标记：

- 英文 `/closing message/i`
- 中文 `/收尾消息/i`

若都没有（子代理没留收尾语），退回 `source.summary`，至少说明它结束了。

存进一个有界的 `settled` 列表：同一子代理只留最新一条，上限 50 条，
收尾语截断 300 字符。

`extractSettlement` matches either marker, falls back to `source.summary`, and
stores into a bounded list (one entry per child, max 50, text clipped to 300
chars).

### 局限 / Limitation

只捕获**插件运行期间**发生的结算。装插件之前就结束的子代理，仍然只有那行
"progress unavailable"。

Only settlements that happen while the plugin is running are captured.

---

## 终止原因：试过又撤掉的功能 / Termination reason: a reverted attempt

**这段记录一次失败的设计，避免以后有人再走一遍。**

This section documents a failed design so nobody walks into it again.

### 动机 / The motivation

子代理结束有五种情况，在父代理看来**长得一模一样**：

| `turn/end` 的 `reason.kind` | 含义 | 危险程度 |
|---|---|---|
| `completed` | 正常干完 | 可以信 |
| `max-tokens` | 输出被上限截断 | **半截话会被当成结论** |
| `interrupted` | 被中断 | 同上 |
| `aborted` | 被中止（`via` 说明谁） | 同上 |
| `error` | 出错（带 `message`/`code`） | 没干活 |

最容易出事的是 `max-tokens`：子代理写了一大段，被掐断，最后那句话看起来
像个完整的收尾（"接下来我要把结论发回父 agent"），父代理就以为它干完了。

### 尝试 / The attempt

1. 在投影里折叠 `turn/end` 的 `reason` → `stopReason`
2. 内存读不到时，用 `sessionQuery.listEvents(id)` 回退读持久化日志

### 为什么失败 / Why it failed

**第一，内存路径几乎没有有效窗口。**

`turn/end` 只在**每轮结束时**产生。而子代理：

- 正在跑 → 本轮还没结束，读不到
- 已结束 → session 卸载，读不到

能读到它的只剩"多轮之间等待回话"那一段，而这段通常很短。

**第二，回退路径的依赖不存在。**

`sessionQuery` 这个服务由 `@deepseek-ai/dsh-session-query` 提供。查 profile：

```sh
ls ~/.dsh/profiles/desktop/node_modules/@deepseek-ai/
# cosmokit  dsh-client-ui-settings  dsh-client-ui-slots  schemastery
```

只有 4 个包。DSH 的其余能力全在 `app.asar` 内部，插件 import 不到；
而 `dsh-experimental-session-search`（profile 里唯一相关的 bundle）
其 `lib/index.js` 只有 **11 字节**，是个空壳。

所以 `ctx.get('sessionQuery')` 永远返回 `undefined`，那段回退代码是死代码。

**Third, the design was never validated against the real profile.** 它通过了
全部单元测试——因为测试测的是"投影逻辑对不对"，而不是"这个服务在你的机器上
存不存在"。

### 结论 / Outcome

0.2.1 整体移除：`stopReason` 字段、`extractStopReason`、
`readStopReasonFromLog`、13 项相关测试、README 的一整节。

静态成本因此从 632 回到 590 tokens。

### 如果以后要做 / If revisited

唯一可行的路是**自己读 session 文件**（`~/.dsh/sessions/<cwd>/<id>/session.v4.jsonl.zstd`）。
可行性已验证——本文档提到的所有实测数据都是这么读出来的，包括那个
`max-tokens` 的样本。

但那属于冷读，需要：逐帧 zstd 解压、全量 JSON.parse、再过滤。
成本必须靠"只从文件尾部扫描"压下来，而且只在"子代理已结算 + 用户确实要问
终止原因"时才付。这比现在的收益/成本比要差得多，所以当时放弃了。

The only viable path is reading the session file directly. Feasibility is proven
— every measurement in this repo was obtained that way — but it is a cold read
requiring full decompress and parse, so the cost has to be contained by tail-only
scanning and only paid in the narrow "already settled, and the caller really needs
the outcome" case.

---

## 为什么不遮蔽 `list_agents` / Upstream `list_agents` is not shadowed

工具名刻意叫 `what_subagents_are_doing`，与上游 `list_agents` 完全不同。
两条理由：

1. `dsh-tools` 里同名注册直接抛 `tool ... is already registered`
2. 走 per-agent scope 遮蔽会让模型同时拿到两套语义冲突的工具

第 2 条不是猜测。上游 issue #7642 记录了实证后果：Agent Teams 注册了
`send_message` / `list_agents` / `interrupt_agent` 到 agent scope，遮蔽了
全局版本；模型按旧的参数形状调用，报 `active teammate not found`。

详见 [`docs/send-message-shadowing.md`](./send-message-shadowing.md)。

Two reasons: same-name registration throws, and per-agent scoping would hand the
model two conflicting toolsets. Issue #7642 is the empirical case.

---

## 零第三方依赖的原因 / Why zero third-party dependencies

插件从 profile 外加载时（`file:` 或 `link:` 安装到工作区），**裸包名解析不到
`app.asar` 内部的 `dsh/node_modules`**。实测报错：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/schemastery'
```

解决方式两条：

1. **手写 JSON Schema**，不用 `@deepseek-ai/schemastery`
2. **不 import 任何 `@deepseek-ai/*` 包**

`ctx.tools.register` 接受普通对象——`defineTool` 只是它的便捷包装。
所以完全绕开了那个依赖。

When the plugin loads from outside the profile, bare specifiers cannot resolve
into the asar's `dsh/node_modules`. So the schema is hand-written and nothing
from `@deepseek-ai/*` is imported. `ctx.tools.register` accepts a plain object;
`defineTool` is only a convenience wrapper.

---

## schema 关键字子集 / The supported JSON Schema subset

DSH 的 `assertSupportedJsonSchema` 只接受这些关键字：

```
type  oneOf  properties  required  additionalProperties  items  enum  const
+ 注解（description / title 等）
```

**`maxItems` 不支持**——实测注册时抛错：

```
schema.properties.narration.maxItems is not a supported keyword
```

所以长度上限由 `projection.js` 的环形缓冲在**运行时**保证，不写进 schema。

注意：`properties` **不做**这个校验，只有 `output.schema` 做。但为了两边
一致，这里都用同一个子集。

`maxItems` is rejected at registration, so caps are enforced at runtime by the
ring buffer instead. Note `parameters` is not asserted at all — only
`output.schema` is. The same subset is used for both out of consistency.

---

## stateVersion 的语义 / What `stateVersion` means

投影 checkpoint 存的是 `(sessionId, key, ver, seq, val)`。

**读了源码才知道的关键点**：`ver` 与当前 `stateVersion` 不匹配时，
那一行在**读取时被直接丢弃**，注释原话是 "never a migration"。

```js
// dsh-session-projection
const usable = row !== undefined && row.ver === def.stateVersion;
let state = usable ? def.stateSchema.parse(row.val) : def.init(header, inheritedEventCount);
```

所以**改 `stateVersion` 不会迁移旧数据，而是静默重折**。
这既是它的用处（改了折叠语义后自动重建），也是它的风险（你以为数据还在，
其实被丢了）。

历史：

| 版本 | 变更 |
|---|---|
| 1 | 初始 |
| 2 | 新增 `settled` |
| 3 | 移除 `stopReason`（0.2.1 回滚） |

Bumping `stateVersion` does not migrate: the row is discarded at read time and
the state re-folds from `init`. Useful when fold semantics change, dangerous if
you assume old data survives.

---

## 失效模式清单 / Failure modes

这个插件有五种失效方式，前四种是**静默的**——没有任何报错。

| # | 模式 | 症状 | 现状 |
|---|---|---|---|
| 1 | 想不起来用 | 插件装了但从不被调用 | 已在 description 开头写触发条件 |
| 2 | 记错工具名 | 找不到工具，以为没装 | 已在 description 第一行写死名字 |
| 3 | 觉得不值 | 宁可 `ls` 看文件 | **未解**，见下 |
| 4 | 描述被读反 | 防轮询的话被读成"别查" | 已改成有边界的许可 |
| 5 | 服务不存在 | 依赖的功能静默降级 | 已移除此类依赖（见终止原因一节） |

### 第 3 条：真的没解 / The unsolved one

实测过一个 Agent Teams 的 lead，它全程**没调用**这个工具，靠
`ls` 看文件大小变化就够了：

> 看到 `probe-nm.cjs` 冒出来、`report.md` 从 84 字节长到 16737 字节，
> 就够判断了。

对比插件能给的：

```
c7d72529 [running] — 触发输出上限验证
    43 steps, last tool: ops_bash, idle 0s
    • 第 1 至 10 回已补到 500 字以上。接下来补第 11 至 20 回。
    • 我准备写个脚本一次改一整批，避免逐个文件手工改错。
```

信息密度差别很明显，**但它的选择在当时是理性的**：`ls` 一次调用就够，
而插件需要先想起来有这个东西。

这不是靠改描述能解决的。**当文件系统本身就是进度信号时，这个插件是冗余的。**
它真正不可替代的场景是：子代理在做**不落盘**的工作（推理、分析、调研），
或者落盘方式看不出进展（改同一个文件、反复调 API）。

Tested against a real Agent Teams lead: it never called the tool, because `ls`
on changed files was sufficient. That is not fixable by wording. When the
filesystem is itself the progress signal, this plugin is redundant. It earns its
keep on work that leaves no useful filesystem trace — reasoning, research, or
repeated edits to one file.

---

## 参考 / References

上游 issue，全部仍开放、无官方回复：

- #4909 — 子代理生命周期交接
- #5360 — parked 状态无通知
- #1202 — 无 terminal-outcome 字段
- #7642 — Agent Teams 遮蔽 subagent 工具

Upstream issues, all open with no official response as of 0.2.1-rc.5.
