# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-10-31

### Removed

- **Termination reason — added in 0.2.0, reverted here.** 0.2.0 began reporting
  `stopReason` (`completed` / `max-tokens` / `interrupted` / `aborted` / `error`)
  read from `turn/end`, with a `sessionQuery` fallback for unloaded sessions.

  It never worked in practice. The reason that stands is:

  **No useful window.** `turn/end` only fires at the end of a turn. While the
  child is running there is no `turn/end` yet; once it settles the session is
  unloaded. Only the gap between turns was ever readable — which is exactly
  when the answer does not matter.

  > **Correction (same release).** The original entry claimed a second reason:
  > that the `sessionQuery` fallback depended on a service missing from the
  > profile. **That was wrong.** The service is mounted by `dsh-base`'s patch
  > (`session-query-sqlite` with `openAt: never`), and `openAt: never` only
  > disables full-text search — `listEvents` and `observeSession` still work.
  > Upstream's own `listChildren` reads the catalog through it. The fallback was
  > not dead code; it was untested. The real lesson is the same one: the unit
  > tests covered fold logic, not whether the path works end to end — and even
  > the premise behind the "missing service" claim was never checked.

  The unit tests passed throughout. Removing this drops the static footprint
  from ~632 back to **~590 tokens**; `stateVersion` stays at 3.

  Reading the session file directly remains an alternative, documented in
  [`docs/how-it-works.md`](docs/how-it-works.md#终止原因试过又撤掉的功能--termination-reason-a-reverted-attempt).

### Added

- **`docs/how-it-works.md`.** All implementation reasoning moved out of the
  README: why narration comes from a projection rather than a cold log read, the
  purity constraints on `apply`, why `reasoning` blocks are excluded, how the
  closing message is captured from the parent session, the supported JSON Schema
  subset, what `stateVersion` actually does, and a failure-mode catalogue
  including the one still unsolved.

### Changed

- **README rewritten for readers, not implementers.** 555 → 331 lines. The
  problem/solution framing, cost tables, state semantics and troubleshooting
  stay; deep implementation discussion moves to `docs/how-it-works.md`. Now also
  states plainly that when the filesystem already reveals progress this plugin is
  redundant — measured against a real Agent Teams lead that never called it.

- **The description opens with the tool name.** The package is
  `what-sub-agents-doing-now` while the tool is `what_subagents_are_doing`. A
  model that saw both spelled out the hybrid `what_subagents_are_doing_now` and
  concluded the tool was missing — a silent total failure, since it never got
  called. The first line is now

  `what_subagents_are_doing — show what each subagent is doing now.`

- **Tool description states the trigger, not just the subject.** A monitoring
  tool that only says *what* it does never gets called: after delegating, the
  model moves on to other work and only looks back on the settlement notice —
  which arrives exclusively at the end. The description now opens with "Use this
  when you want to know how far a running subagent has gotten…".

  The closing anti-polling line was also reworded. It used to be unconditional —
  `Do not poll in a loop: you are notified when a subagent settles.` — which
  reads as "just wait for the notice" and removes the motive to check mid-task.
  It now permits a single curious-or-suspicious check and only forbids looping.

### Fixed

- **`buildRow` threw on unreadable projection state.** `readProgress` only
  guarded `undefined`; `stateOf` returning `null` reached `progress.lastAt` and
  threw `TypeError`, failing the whole tool call. Fixed with an object check plus
  a `narration` array guard, covered by eight tests that reproduce each shape.
  Verified by reverting the guard: the tests fail with
  `Cannot read properties of null (reading 'lastAt')`.

## [0.2.0] — 2026-10-31

> **Superseded by 0.2.1** — the termination-reason feature was reverted. Kept
> for the record.

### Added

- **Finished children keep their closing message.** Settling unloads the child's
  session, so its narration vanished and every finished child collapsed into a
  bare "session not resident in memory" line. The settlement notice still lands
  in the *parent* session carrying the closing text; the projection folds it
  into a bounded `settled` list.

- ~~Termination reason~~ — reverted in 0.2.1, see above.

### Changed

- `stateVersion` 2 → 3.


## [0.1.1] — 2026-10-31

### Fixed

- **Tool call failed after a subagent settled** —
  `tool "what_subagents_are_doing" returned invalid output:
  "value[0].narration" must be an array`.
  When a child finishes, its session is unloaded from memory, so progress becomes
  unreadable. The old code set `narration: null`, which DSH's output validation
  rejects because the schema declares an array. It now returns `[]` plus a `note`
  explaining that the session was unloaded. Regression covered in
  `test/integration.dsh.mjs` and `test/schema.dsh.mjs`.

### Changed

- Tests take the DSH install directory as an argument (or `DSH_INSTALL` env var)
  instead of hard-coding absolute paths, so the repo is portable.
- README restructured for public consumption; Chinese version moved to
  `README.zh.md`.

## [0.1.0] — 2026-10-31

### Added

- `what_subagents_are_doing` tool: returns the progress notes each subagent wrote
  itself (the `text` blocks of `assistant/message`), instead of only
  `running` / `inactive`
- Four states: `running`, `idle`, `possibly-stuck` (heuristic), plus `external`
- Paging: `limit` (1–50, default 6) and a `before` cursor to look further back
- Incremental hint: `narrationSinceLastLook` counts notes added since the previous
  look by the same parent
- Volume hints: `narrationTotal` / `narrationOmitted` let the model decide whether
  to page back
- `scope: descendants` for whole-subtree inspection

### Implementation

- Narration is read through a **projection unit**
  (`ctx.sessionProjections.register`), never through a full log read — the latter
  decompresses the entire session on every poll
- **Zero third-party dependencies**: no `@deepseek-ai/*` imports, standard JSON
  Schema written by hand. Plugins loaded from outside the profile cannot resolve
  bare specifiers into `app.asar`
- Tool name deliberately differs from upstream `list_agents` to avoid both a
  duplicate-registration error and the semantic conflict documented in upstream
  #7642
- Ring buffer capped at 200 notes per subagent, 200 characters per note;
  `reasoning` blocks are always excluded

### Safety

- Read-only: no session writes, no event appends, no
  `send_message` / `interrupt_agent` calls
- Catalog failures throw instead of returning an empty array
- Unreadable progress returns `narration: []` plus a `note`, never a silent miss
- Projection registration failure degrades instead of aborting profile startup

### Verification

- 33 pure-logic unit tests (`test/projection.test.mjs`)
- 17 schema checks against DSH's real `assertSupportedJsonSchema` /
  `validateJsonSchemaValue` (`test/schema.dsh.mjs`)
- 24 integration checks (`test/integration.dsh.mjs`)

[0.1.1]: https://github.com/REALOIYO/what-sub-agents-doing-now/releases/tag/v0.1.1
[0.1.0]: https://github.com/REALOIYO/what-sub-agents-doing-now/releases/tag/v0.1.0
