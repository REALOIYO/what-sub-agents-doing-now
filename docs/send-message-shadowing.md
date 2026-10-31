# 为什么上游 `send_message` 联系不上子代理，以及能不能自己补

> 只读分析，2026-10-31。基于 DSH `0.2.1-rc.5` 实际安装包源码。
> 结论：**功能上游本来就有**，被第三方包遮蔽；自补可行（约 135 行），但优先级低。

---

## 1. 现象

用 `subagent` 派了子代理之后：

- `list_agents()` 只返回 `lead`，看不到自己派出去的子代理
- `send_message({ target: '<子代理 id>' })` 报 `active teammate "..." not found`
- 无法在运行中给子代理发消息、纠错、叫停

## 2. 根因：Agent Teams 遮蔽了 subagent 的原生工具

### 2.1 两套同名工具并存

| 工具 | subagent 版（原生） | Agent Teams 版 |
|---|---|---|
| `send_message` | `{ agent_id, message }` | `{ target, message }` |
| `list_agents` | `{ scope }` → 子代理 | 无参数 → 队友 |
| `interrupt_agent` | `{ agent_id }` | `{ target }` |

Agent Teams 的包 `@deepseek-ai/dsh-experimental-tool-agent-team` 注册了 9 个工具：

```
spawn_teammate, send_message, list_agents, wait_agent, interrupt_agent,
team_task_create, team_task_list, team_task_get, team_task_update
```

其中前 5 个里的 3 个（`send_message` / `list_agents` / `interrupt_agent`）与 subagent
原生工具**同名**。

### 2.2 遮蔽怎么发生的

Teams 用 **agent scope** 注册（`scoped.tools.register`），而原生工具注册在全局层。
`dsh-tools` 的解析规则：

> Scoped registrations shadow globals; one visibility resolver feeds
> presentation, lookup, and dispatch.
> （`dsh-tools/lib/index.js:117785`）

于是 agent scope 的 Teams 版本胜出，全局的原生版本不可见。

这正是上游 [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642)
报告的情形，原文：

> 模型按 `subagent` 正常委派之后，既无法列出、也无法联系它自己创建的子代理。
> 错误信息只说明"找不到这个 teammate"，不提示任何可行的替代路径。

## 3. 原生工具其实很好用

`dsh-tool-subagent-control/lib/index.js` 里：

```js
name: "send_message",
parameters: { agent_id, message },
description: "Send a message to an agent. A working agent receives it at its
             next step; an idle agent starts a new turn with it.
             Returns delivery confirmation, not the agent's answer."
```

**"A working agent receives it at its next step"**——这就是运行中发话、纠错的能力，
本来就支持。

`interrupt_agent` 同理，原生就存在。

## 4. 自补方案（路径 B）：直接转调 `ctx.subagents`

### 4.1 关键验证：能不 import brandString 吗

原生工具内部用 `brandString(args.agent_id)` 包一层。`brandString` 来自
`@deepseek-ai/dsh-brand`，我的插件零依赖，不能 import。

查了 `dsh-subagent/lib/index.js` 里 `brandString` 的全部用法：

```
@60157:  const childId = spec.childId ?? brandString(randomUUID());   // 生成 id
@63470:  const pendingId = brandString(randomUUID());                 // 生成 id
```

**只在生成 id 时用，从不校验传入的 id。**

再看 `sendMessage` 实现：

```js
async sendMessage(sender, targetId, content, options) {
    if (this.ctx.agents.get(sender.id) !== sender) throw ...  // 只校验 sender 存活
    this.assertAdmitting(sender);
    const senderActivation = this.resident.get(sender.id);
    if (senderActivation !== void 0
        && senderActivation.parent.id === targetId) {          // targetId 当字符串比较
        return this.sendToParent(...);
    }
    return this.deliverToChild(sender, targetId, content, {...});
}
```

`deliverToChild` / `deliverFollowup` 里 `childId` 全程当 Map key 和字符串用。
包里也不存在 `isBrand` / `assertBrand` 之类的运行时断言。

**结论：传裸字符串可行，不需要 `@deepseek-ai/dsh-brand`。**

### 4.2 interrupt 的调用方式

```js
interrupt(targetSessionId, { kind: 'ancestor', agent: exec.agent })
```

会校验目标必须是调用者的活后代（`activation.ancestry.has(authority.agent)`），
否则抛 `UNAUTHORIZED`。

### 4.3 实现的形状

```js
// subagent_send_message
async execute(args, exec) {
  const messageId = await ctx.subagents.sendMessage(
    exec.agent,
    args.agent_id,                        // 裸字符串，已验证
    [{ type: 'text', text: args.message }],
    { signal: exec.signal },
  );
  return { messageId };
}

// subagent_interrupt
async execute(args, exec) {
  await ctx.subagents.interrupt(args.agent_id, {
    kind: 'ancestor',
    agent: exec.agent,
  });
  return { ok: true };
}
```

两个 API 都在 `ctx.subagents` 上，是公开 Cordis 服务，插件本来就 `inject: ['subagents']`。

### 4.4 工作量

| 项 | 行数 |
|---|---|
| `subagent_send_message` 定义 | ~45 |
| `subagent_interrupt` 定义 | ~40 |
| 测试 | ~50 |
| **合计** | **~135** |

### 4.5 风险评估

| 风险 | 评估 |
|---|---|
| 破坏 DSH | 无。纯新增工具，不改上游，不遮蔽任何东西 |
| 工具名冲突 | `subagent_send_message` / `subagent_interrupt` 与 Teams 版完全不同 |
| 传错 id | 上游自己有校验，会显式抛 `UNAUTHORIZED` / `NOT_RESUMABLE` / `PARENT_UNAVAILABLE` |
| 子代理已结束 | 上游有 `coldResume`，会自动冷启动继续对话 |

## 5. 为什么最终决定搁置

1. **上游本来就有**，缺的不是能力而是可见性。再包一层是重复造轮子。
2. **歧义消不掉**：只要 Agent Teams 还开着，模型就会在两套 `send_message` 之间选错。
   加第三套工具不能解决这个问题，只会让选择更多。
3. **正确解法不在这里**：要么给上游提 issue 要求 Teams 包在不启用时不要注册，
   要么在 Teams 包里做兼容。在自己的插件里转调只是绕过。
4. 当前插件（看进度）刚修完 bug，还没经过充分使用验证，不宜马上扩功能。

## 6. 如果哪天要用，怎么启用

按 4.3 落地即可。真正需要判断的是**要不要在同一仓库**：

- 同一个仓库：语义连贯（"看" + "说"），但插件名 `what-sub-agents-doing-now` 只覆盖"看"
- 分仓库：职责清晰，但要维护两个插件

倾向同仓库，用前缀区分：`what_subagents_are_doing`（看）/ `subagent_*`（说）。

## 7. 相关上游讨论

| 编号 | 内容 | 状态 |
|---|---|---|
| [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642) | Teams 遮蔽 subagent 工具，子代理不可见不可达 | 开放，无官方回复 |
| [#9523](https://github.com/deepseek-ai/deepseek-harness/discussions/9523) | 同名工具冲突、`wait_agent` 语义错位 | 开放 |
| [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) | 生命周期交接契约缺失 | 开放，无官方回复 |
| [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) | parked 状态无完成通知 | 开放 |

上游 Issues 已关闭（`has_issues: false`），唯一反馈入口是 Discussions，官方回复数为 0。
