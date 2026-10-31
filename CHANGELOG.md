# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/REALOIYO/whatsubagentsdoingnow/releases/tag/v0.1.1
[0.1.0]: https://github.com/REALOIYO/whatsubagentsdoingnow/releases/tag/v0.1.0
