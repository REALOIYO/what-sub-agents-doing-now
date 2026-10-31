# whatsubagentsdoingnow — 实现方案

> 状态：**设计稿**（未写代码）
> 目标：让主代理不必轮询、不必猜，直接看到每个子代理"此刻在干什么"。
> 依据：DSH `0.2.1-rc.5` 实际安装包 + 官方文档知识库（`dsh-plugin-dev-kb`）。

---

## 1. 要解决什么

上游 `list_agents` 的 `status` 只有二值：

```js
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
```

（`dsh-tool-subagent-control/lib/types/list-agents.js`）

`inactive` 同时覆盖四种完全不同的情况：

| 真实情况 | 父代理看到 |
|---|---|
| 干完了，结果已交付 | `inactive` |
| 崩了 | `inactive` |
| 卡在某句话上，永远不动了 | `inactive` |
| 在等自己的子代理回报 | `inactive` |

父代理无法区分，只能轮询。这是上游 #5360 / #1202 / #4909 反复报告、至今未修的问题。

**本插件不改上游、不遮蔽上游工具**，只在旁边加一个"看得见"的入口。

---

## 2. 核心思路

不猜状态，直接回传子代理**自己说过的话**。

子代理每一步都会在 `assistant/message` 事件里留下 `text` block，就是 UI 上那些旁白：

```
• 核对第 11 题选项的系数（长图中这几行只显示根号）：
• 数学完成，共 23 题
```

实测（本机真实子代理会话 `2aadf499-…`）：

```
旁白条数 6, 总字符 190, 平均 32, 最短 11, 最长 68
工具调用分布: read×3, read_image×15, ops_bash×9, glob×1, todo_write×1, write×1, edit×1
```

**6 条旁白总共 190 字符**——体积完全可控。返回最后 2-3 条即可表达"卡在哪"或"已收工"。

归因问题因此消失：信息是子代理自己产的，不是插件推断的。

---

## 3. 数据来源（三处，全部官方 API）

### 3.1 子代理清单 —— `ctx.subagents.listChildren()`

```ts
listChildren(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalogEntry[]>
```

返回 `{ id, createdAt, mode, label }`。**文档明确写"不携带执行状态"**（`subagent.md:233`），与实测一致。

`mode: 'continuable'` 可用 `send_message`；`'external'` 无本地 Session，跳过。

### 3.2 旁白 —— 注册投影（**不用 listEvents**）

这是本方案的**关键设计约束**。官方 `defensive-patterns/conversation-and-session.zh.md` 第 50 行：

> **冷读是最后手段**。可用的缓存要先于原始日志被读取；只有没有任何投影覆盖该数据时才走冷读。「小会话可以全读」这一例外已移除。

第 54 行把违规写死了：

> 缓存判断的 `else` 分支直接打开完整日志，即属违规。

`listEvents(sessionId)` / `readSession(sessionId)` 就是冷读——每次都解压整条日志。本机一个会话 2.4 MB 压缩、解压后 6.2 MB。父代理每调一次工具就付一次这个代价，**必然卡顿**。

所以旁白必须走**投影**：`ctx.sessionProjections.register()` 注册一个纯单元，框架自己订阅 `session/event` 并折叠，值常驻内存。

```js
ctx.sessionProjections.register({
  key: 'whatsubagentsdoingnow',
  stateVersion: 1,
  init: () => ({ narration: [], lastTool: undefined, steps: 0, lastAt: 0 }),
  apply: (state, event) => fold(state, event),
  // host-only：不需要 client 渲染，省掉 wire
})
```

`register` 不传 `wire` 即为 **host-only 单元**（`session-projection.md:230`）：状态不进客户端快照，但仍照常 checkpoint。本插件只服务 agent，不需要 UI。

折叠规则：

| 事件 | 动作 |
|---|---|
| `assistant/message` | 取 `content` 里 `type === 'text'` 的 block，推入环形缓冲（上限 5 条），**丢弃 `reasoning`** |
| `tool/call` | 记 `lastTool = data.name`，`steps++` |
| `step/start` / `step/end` | 刷新 `lastAt` |
| 其他 | 原样返回，保持引用不变（`Object.is` 不变则不通知） |

排除 `reasoning` 不是可选项——实测单条 reasoning 有 2000+ 字符，混进来会瞬间撑爆返回体积。

### 3.3 实时状态 —— `ctx.agents.get(sessionId)`

只取 `status === 'running'` 与否，但**配合 `lastAt` 用**：

```js
const alive = agents.get(id)?.status === 'running'
const idleMs = Date.now() - state.lastAt
```

`inactive && idleMs > 阈值` → 疑似卡住；`inactive && 最后一条旁白像收尾语` → 大概率完成。
这两条都是**启发式**，所以输出里要标清楚，不能让模型当成确定事实。

---

## 4. 工具形态

```ts
ctx.tools.register(defineTool({
  name: 'what_subagents_are_doing',
  description:
    'Show what each of your subagents is doing right now, based on the '
    + 'progress notes it wrote (not just running/inactive). Use this when you '
    + 'need to know whether a child is working, stuck, or finished.',
  parameters: {
    scope: {
      type: 'string',
      enum: ['children', 'descendants'],
      required: false,
      description: 'children (default) or the whole tree below you.',
    },
    includeNarration: {
      type: 'boolean',
      required: false,
      description: 'Include the last few progress notes. Defaults to true.',
    },
  },
  output: { schema: /* 见下 */ },
  async execute(args, exec) { /* ... */ },
}))
```

### 返回结构

```json
[
  {
    "id": "2aadf499-da2d-4259-855d-68e5b268b8cb",
    "label": "做2020全国III卷文科数学",
    "state": "running | idle | possibly-stuck",
    "idleSeconds": 12,
    "steps": 42,
    "lastTool": "write",
    "narration": [
      "核对第 11 题选项的系数（长图中这几行只显示根号）",
      "数学完成，共 23 题"
    ]
  }
]
```

`state` 三值，语义写进描述：

| 值 | 判定 |
|---|---|
| `running` | `agents.get(id).status === 'running'` |
| `idle` | 非 running，且 `idleSeconds <= 阈值`（默认 120s） |
| `possibly-stuck` | 非 running，且 `idleSeconds > 阈值` |

**注意 `state` 仍是启发式**。`possibly-stuck` 的意思是"该看一眼了"，不是"它坏了"。措辞必须在 description 里讲明白，否则模型会把正常等待误判成故障。

---

## 5. 安全设计（不能搞崩 dsh）

这是本方案最重要的部分。逐条对照红线。

### 5.1 纯读，零写入

- 不调 `send_message` / `interrupt_agent` / `materialize`，只读。
- 不 `append` 任何 session 事件。
- 不改 `~/.dsh` 下任何配置文件。
- 不注册 `session/event` 的写钩子。

### 5.2 不遮蔽上游工具

**工具名与 `list_agents` 完全不同**（`what_subagents_are_doing`）。

原因：`dsh-tools/lib/index.js:116565` 里同名注册直接抛错：

```js
throw new Error(scope === void 0
  ? `tool "${name}" is already registered (...)`
  : `tool "${name}" is already registered in this scope`)
```

虽然可以走 per-agent scope 遮蔽，但上游 #7642 已经证明遮蔽会引发灾难——模型拿到两套语义冲突的工具，调用直接报 `active teammate not found`。**本插件绝不重蹈覆辙。**

### 5.3 旁白必须过滤敏感内容

旁白是模型自由文本，可能含：
- 文件绝对路径（`F:\DSH_workspace\...`）
- API key / token 片段
- 用户隐私内容

处置：

1. **默认截断**：每条旁白上限 200 字符，超出加 `…`
2. **路径不脱敏**——但**只在本地工具返回里**，不进日志、不上报
3. 上限条数 5，`includeNarration: false` 可完全关闭

不做激进的正则脱敏（会误伤正常文本），靠"条数 + 长度"两道闸门控制暴露面。

### 5.4 防御性读取

```js
try {
  const entries = await ctx.subagents.listChildren(parentId, exec.signal)
} catch (err) {
  // 显式失败，绝不静默返回空数组
  return [{ kind: 'diagnostic', reason: 'unavailable', detail: ... }]
}
```

上游 `listChildren` 会抛 `SUBAGENT_CONTROL_QUERY_UNAVAILABLE` /
`SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE`。**不能 catch 后 return []**——那会让模型以为"没有子代理"，比报错更危险。

同理，投影 `stateOf(session, key)` 返回 `undefined`（键未注册）时也是显式 diagnostic，不是空值。

### 5.5 投影必须是纯函数

`apply(state, event)` 里**禁止**：
- 网络请求
- 文件 I/O
- 读 `Date.now()`（时间戳用 `event.time`）

违反会让框架的增量驱动退化为全量重算，拖慢整个 session。官方明文（`session-projection.md:211`）：

> every committed event passes every registered unit's `apply` (eager drive)

这是**每个事件都要跑一次**的热路径，必须 O(1) 且无副作用。

### 5.6 沙箱开发

按 `dsh-dev-sandbox` 规范：

- 沙箱 profile：`sb-whatsubagentsdoingnow`
- 端口：`3081` 起（避开主力 59274）
- `link:` 挂载，改代码重启即生效
- **绝不碰主力 profile `desktop`**
- 主力安装由用户决定，不由 agent 自动执行

---

## 6. 关键技术风险

| 风险 | 说明 | 应对 |
|---|---|---|
| ~~投影 key 冲突~~ | **已验证：无阻碍**。`register()` 运行时只校验 `stateVersion` 是非负整数，无 key 白名单（`unknown key` / `allowedKeys` / `PROJECTION_KEYS` 全部 `[MISS]`） | ✅ 已排除，见 6.0 |
| `stateOf` 需要 `Session` 对象 | 不是 sessionId | 通过 `ctx.sessions.get(sessionId)` 拿 |
| 子会话可能是冷 Session | 未 materialize 时拿不到 | 显式降级为 `narration: undefined` |
| `stateSchema` 校验 | 文档要求 `stateVersion` 从 1 起，改字段必须自增 | 首版定死 schema |
| 递归深度 | `listDescendants` 递归读目录 | 只读 catalog，不读子日志，天然有界 |

### 6.0 阻塞项已排除（实测）

原以为 `SessionProjectionMap` 是封闭联合、第三方注册会被拒。**实测否定了这个担心。**

`dsh-session-projection/lib/index.js` 的 `register()` 运行时实现全文只有一处校验：

```js
if (!Number.isSafeInteger(definition.stateVersion) || definition.stateVersion < 0)
  throw new Error(`session projection ${JSON.stringify(definition.key)} stateVersion must be a non-negative integer, ...`)
```

没有 key 白名单。检索结果：

```
unknown key      [MISS]
invalid key      [MISS]
assertKnown      [MISS]
allowedKeys      [MISS]
PROJECTION_KEYS  [MISS]
not registered   [HIT ]   ← 只是 stateOf 的常规分支
```

`SessionProjectionMap` 只存在于 TypeScript 类型层（用于 `stateOf` 的类型推导），运行时不拦。

**结论：自定义 key 可注册。投影方案成立。**

唯一约束：同一 key 若被多处注册，`stateVersion` 必须一致，否则抛错：

```js
throw new Error(`session projection key ${...} is already registered at stateVersion ${...}; refusing to share it with stateVersion ${...}`)
```

本插件独占 `whatsubagentsdoingnow` 这个 key，不会撞。

### 6.1 备选路径（若投影方案在迁移/升级中失效）

若第三方无法注册 projection key，退到**有界冷读**：

```js
const records = await ctx.sessionQuery.filterEvents(childId, [
  { kind: 'type', values: ['assistant/message'] },
])
```

`filterEvents` 的优势（`session-query.md:151`）：

> 消息、工具调用和工具结果…会纳入语义文本；**推理（reasoning）块…则不会**。

框架层已经帮我们排除了 reasoning。但仍需自己加缓存：

```js
// key: `${childId}:${lastSeq}`，命中则不重读
```

限制：仅当 `includeNarration` 且子代理数 ≤ 3 时才走这条路，避免父代理一次拉十几个子会话。

---

## 7. 实施步骤

| # | 步骤 | 产出 |
|---|---|---|
| 1 | ~~验证投影可注册性~~ **已完成：通过** | ✅ 见 6.0 |
| 2 | 建仓 + `package.json` + peerDependencies | 骨架 |
| 3 | 实现投影单元 `fold()` + 单测 | 纯函数，可离线测 |
| 4 | 实现工具 `execute()` | 主体 |
| 5 | 建沙箱 `sb-whatsubagentsdoingnow`，`link:` 挂载 | 隔离环境 |
| 6 | headless 冒烟：加载 + 工具注册 | 不崩即通过 |
| 7 | 真实子代理会话验证（造一个长任务） | 端到端 |
| 8 | 文档 + 交用户决定是否进主力 | 交付 |

**步骤 1 已提前完成**（原本是硬门槛）。现在可以直接从步骤 2 开始。

---

## 8. 明确不做

- ❌ 不修上游"父代理消失时结算丢失"（需要改 asar，且升级即失效）
- ❌ 不注册 `list_agents` 同名工具
- ❌ 不做 UI 面板（host-only，省掉 client 构建）
- ❌ 不做跨父代理聚合（只看自己的下级）
- ❌ 不写 `~/.dsh` 配置

---

## 9. 参考依据

| 文件 | 用途 |
|---|---|
| `site/reference/subsystems/subagent.md:233,383` | `listChildren` 语义、"不携带执行状态" |
| `site/reference/subsystems/session-query.md:151,269` | `filterEvents` 排除 reasoning、有界读取 |
| `site/reference/subsystems/session-projection.md:209-248` | `ctx.sessionProjections.register` / `stateOf` |
| `extra/defensive-patterns/conversation-and-session.zh.md:7,50` | **冷读禁令**（决定投影方案） |
| `site/develop/basic/tool.md` | `defineTool` 骨架 |
| `dsh-tools/lib/index.js:116565` | 同名工具抛出（决定不遮蔽） |

---

## 10. 待用户确认

1. 工具名 `what_subagents_are_doing` 是否合适？（备选 `subagent_progress`）
2. 旁白条数上限：3 / 5 / 8？
3. `possibly-stuck` 阈值：120s 还是可配？
4. 是否需要 `includeNarration: false` 的完全关闭开关？
5. 沙箱验证通过后，进主力还是先放着？
