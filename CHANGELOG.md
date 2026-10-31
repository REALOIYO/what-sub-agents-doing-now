# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Trimmed the static token cost from ~783 to ~484 tokens.** The earlier figure
  was measured on pretty-printed JSON; the model actually receives compact JSON.
  On top of that correction, `description` and the parameter schemas were
  tightened and the redundant inner `additionalProperties: false` was dropped
  (the outer one still enforces the shape). Field semantics now live in
  `description` once instead of being repeated in the schema.
- Documented the `file:` vs `link:` install difference: only `link:` (a symlink)
  falls inside the range `dsh-hmr`'s `profileRoots()` observes, so only `link:`
  hot-reloads code edits. `file:` requires a restart.
- Added a token-cost section with measured static and per-call figures, and an
  explicit note that returns accumulate in conversation history.

### Documented

- **Nested subagents are untested.** Only one level of delegation
  (parent → child) has been verified. `scope: 'descendants'` delegates to upstream
  `listDescendants()`, which is documented to recurse, but that path has not been
  exercised against a real grandchild tree here.
- `image` and `reasoning` blocks are skipped by design; a step that only emits an
  image produces no narration entry.

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
