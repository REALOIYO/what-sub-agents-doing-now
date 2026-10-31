# whatsubagentsdoingnow

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.1--rc.1-4D6BFE?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**See what each subagent is actually doing, right now.**

> A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that
> surfaces the progress notes a subagent wrote itself — not just `running` / `inactive`.
>
> [中文说明](README.zh.md)

---

## The problem

When you delegate work with `subagent`, the parent agent only sees a binary status:

```js
function statusOf(agents, id) {
    return agents.get(id)?.status === 'running' ? 'running' : 'inactive';
}
```

That single word `inactive` covers four completely different situations:

| What actually happened | What the parent sees |
|---|---|
| Finished, result delivered | `inactive` |
| Crashed | `inactive` |
| Stuck mid-sentence, going nowhere | `inactive` |
| Waiting on its own children | `inactive` |

The parent cannot tell them apart. It either polls in a loop or guesses.

## The fix

**Stop guessing. Show what the child wrote.**

Every subagent leaves progress notes in its session as it works. This plugin reads
those notes and hands them back to the parent:

```
child-a [running] — verify plugin compatibility
    42 steps, last tool: write, idle 0s
    • Found the asar, now reading requiredStartupEntryIds
    • Miscalculated the header offset; fixed the pickle layout and rerunning
```

Now you know: **it hit a parsing bug, fixed it, and is moving on.** No status enum
can express that.

## Install

```sh
dsh plugin --profile <profile> add file:/path/to/whatsubagentsdoingnow
```

Or use the plugin manager in DSH settings. Restart DSH afterwards.

## Usage

One new tool on the model side:

```js
what_subagents_are_doing({
  scope?,            // 'children' (default) | 'descendants'
  limit?,            // narration entries per subagent, 1-50, default 6
  before?,           // only entries older than this seq — page backwards
  includeNarration?, // false for a compact status-only listing
})
```

### What each state means

| state | Rule | Meaning |
|---|---|---|
| `running` | agent status is running | Actively working |
| `idle` | not running, idle under threshold | Not working (may be done, may be waiting on children) |
| `possibly-stuck` | not running, idle over threshold | **Heuristic nudge**: worth a look, *not* proof of failure |
| `external` | child runs off-machine | Progress unavailable |

> `possibly-stuck` is not a failure verdict. A child legitimately waiting on its
> own descendants lands here too.

### Paging backwards

Every row carries two counters:

```
(showing 6 of 37; 31 older omitted — pass before=412 to see them)
```

`narrationTotal` is how many notes it wrote in all; `narrationOmitted` is how many
this response left out. The model sees the gap and decides whether to page back.

Look twice and the second call adds `narrationSinceLastLook`:

```
(+5 since you last looked)
```

Exact count of notes added since the previous look.

## Configuration

```yaml
- id: whatsubagentsdoingnow
  name: whatsubagentsdoingnow
  config:
    stuckMs: 120000   # idle ms before possibly-stuck, default 120000 (2 min)
```

## Design notes

### Narration comes from a projection, not a full log read

DSH's own defensive-patterns guide is explicit:

> Cold reads are the last resort. An available cache must be read before the raw
> log; a cache miss that falls through to opening the complete log is a violation.

A child session log can exceed several MB once decompressed. Reading it on every
poll would make long sessions crawl. This plugin registers a **projection unit**
instead: the framework subscribes to events and folds them, keeping the value in
memory.

### Only `text` blocks, never `reasoning`

`assistant/message` content carries both. A single reasoning block can run past
2000 characters, and it is internal deliberation rather than something the child
*says*. Including it would blow up the parent's context. Only `type === 'text'`
is kept.

### Upstream `list_agents` is not shadowed

Two reasons:

1. `dsh-tools` throws `tool "..." is already registered` on a duplicate name.
2. Shadowing through a per-agent scope gives the model two conflicting tools —
   proven to fail in upstream
   [#7642](https://github.com/deepseek-ai/deepseek-harness/discussions/7642)
   (`active teammate not found`).

So this tool's name is entirely different.

### Zero third-party dependencies

When a plugin loads from outside the profile (workspace path, `link:` mount),
`import '@deepseek-ai/dsh-tools'` fails with `ERR_MODULE_NOT_FOUND` — bare
specifiers resolve against `dsh/node_modules` *inside* `app.asar`.

`ctx.tools.register` only needs a plain object; `defineTool` is a convenience
wrapper. So this plugin hand-writes standard JSON Schema and imports nothing.

### `maxItems` is not allowed in schemas

DSH's `assertSupportedJsonSchema` accepts only `type` / `oneOf` / `properties` /
`required` / `additionalProperties` / `items` / `enum` / `const` plus
annotations. Size limits are enforced by the runtime ring buffer (200 entries)
rather than expressed in the schema.

## Safety boundaries

- **Read-only**: writes no session events, never calls
  `send_message` / `interrupt_agent`
- **No `~/.dsh` writes**: zero config mutation
- **Failures are explicit**: catalog errors throw rather than returning `[]`
  (an empty array would tell the model "you have no subagents", which is worse)
- **Session gone**: returns `narration: []` plus a `note` explaining why — never
  pretends the child said nothing
- **Bounded size**: 200 characters per note, 200 notes per subagent

## Known limits

- `possibly-stuck` is a heuristic, not a failure verdict
- A finished child's session is unloaded from memory; narration is unavailable
  then (an explicit `note` says so)
- `narrationSinceLastLook` uses an in-memory cursor that dies with a DSH restart;
  the field is simply omitted afterwards
- Observes direct descendants only, no cross-parent aggregation
- Does **not** fix upstream's "settlement lost when the parent vanished" problem
  (that would require patching `app.asar`)

## Troubleshooting

### Installed but the tool does not appear

```sh
dsh plugin --profile <profile> list | grep whatsubagentsdoingnow
```

Confirm it is listed, then restart DSH. If it is still missing afterwards, check
startup stderr for `skipping profile bundle`.

### `narration must be an array`

Fixed in 0.1.1. Older versions returned `null` instead of an empty array once the
child settled, which DSH's output validation rejects. Upgrade.

## Development

```sh
# Pure-logic unit tests (no DSH needed)
node test/projection.test.mjs

# Schema and integration tests (need DSH's Electron runtime for app.asar)
"<DSH install dir>/DeepSeek Harness.exe" test/schema.dsh.mjs <installDir>
"<DSH install dir>/DeepSeek Harness.exe" test/integration.dsh.mjs <installDir>
```

The `DSH_INSTALL` environment variable can replace the `installDir` argument.

## Background

Related upstream discussions (all still open as of 0.2.1-rc.5, zero official replies):

| # | Topic |
|---|---|
| [#4909](https://github.com/deepseek-ai/deepseek-harness/discussions/4909) | Lifecycle handoff contract missing — children orphaned when the parent exits |
| [#5360](https://github.com/deepseek-ai/deepseek-harness/discussions/5360) | Set-back to input requested mid-turn is not honoured |
| [#1202](https://github.com/deepseek-ai/deepseek-harness/discussions/1202) | State model has no terminal-outcome field; three surfaces guess differently |

See also [`docs/send-message-shadowing.md`](docs/send-message-shadowing.md) for why
`send_message` cannot reach subagents (Agent Teams shadowing) and whether a
workaround is worth building.

## License

[MIT](LICENSE)
