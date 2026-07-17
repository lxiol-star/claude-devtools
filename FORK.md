# Fork Notes

This is a personal fork of [`matt1398/claude-devtools`](https://github.com/matt1398/claude-devtools)
that turns the Claude-only session viewer into a **multi-backend local AI-session
debugger** and adds a batch of local, zero-outbound observability features
modeled on [Langfuse](https://langfuse.com).

- **Upstream:** `matt1398/claude-devtools` (kept as git remote `origin`, pull-only)
- **Fork:** `lxiol-star/claude-devtools` (remote `fork`)
- **Branch:** `feat/multi-backend-langfuse-parity` (branched from upstream `main@16cc3c8`)
- **Design red lines (unchanged from upstream):** does not wrap/modify the agent,
  zero outbound network, single-user, reads on-disk logs only.

## What this fork adds over upstream

### 1. Multi-backend parsing
Upstream reads only Claude Code sessions (`~/.claude`). This fork adds:
- **`KimiBackend`** — parses Kimi Code `~/.kimi-code` wire logs.
- **`CodexBackend`** — parses Codex `~/.codex` rollout JSONL.
- Both implement the same `DataBackend` interface as `ClaudeBackend`
  (`src/main/backends/`).
- **Cross-backend "All" aggregate view** — the same repository used from
  Claude/Kimi/Codex merges into one card via a backend-independent **canonical
  project id** (`base64url(path)`); session routing resolves the canonical id
  back to each backend's native id (`resolveNativeProjectId`).
- Chinese i18n (en/zh) under `src/renderer/i18n`.

### 2. Source filtering is client-side
Selecting a backend chip is now a pure client-side view filter — no context
switch, no reload/spinner. Multi-source local data is loaded aggregately once;
merged cards carry a `sourceBackends` union.

### 3. Langfuse-parity local features
Added only the capabilities that fit a local, read-only, offline, single-user
tool. **Deliberately excluded** (they require networking / model calls /
multi-tenancy and would break the red lines): SDK/OTel ingestion, prompt
management/CMS, LLM playground, LLM-as-judge auto-eval, cloud multi-user/RBAC,
production alerting/webhooks.

| Feature | Notes |
|---|---|
| Session annotations | tags + 0–5 star score + note, stored in the app config (`~/.claude/claude-devtools-config.json`), keyed `contextId:projectId:sessionId` |
| Sidebar filtering | filter sessions by tag / min score; named **saved filter views** |
| Execution timeline (Gantt) | reuses upstream's `getWaterfallData`; latency/token drill-down (by type, by tool); click a row to jump to that step in the conversation |
| Cross-session analytics dashboard | `recharts` charts: trends, by-backend, by-project, rating distribution + by-tag; **CSV export**; built from cheap list data (session/message counts, `contextConsumption` token proxy) — cost/precise latency stay per-session |
| Side-by-side comparison | pick 2–3 sessions → diff tokens/duration/tool-calls/cost (Claude vs Kimi vs Codex) |
| Test-fixture export | export a session's tool calls as `{prompt, toolName, input, output, isError}` JSON |

### 4. Bug fixes
- **Codex `custom_tool_call` / `custom_tool_call_output`** now parse into
  `tool_use` / `tool_result` (were dropped as system noise — one real session
  lost 536 tool events).
- **Aggregate-mode context routing** — session detail, waterfall timeline, and
  the AI-group backend label now use the session's *origin* context, not the
  globally-active one (fixed the same class of bug in three places; see the
  pattern write-up below).

## Progress / status

- **Quality gates:** `pnpm typecheck` clean, `pnpm lint` 0 errors, **838 tests
  passing**, `pnpm build` exits 0.
- **Committed** on `feat/multi-backend-langfuse-parity` (`b3de7a9`), pushed to
  the `fork` remote. No PR opened yet (personal use / trial).
- **New dependency:** `recharts@2.15.4` (pinned; local SVG rendering only).

## Keeping up with upstream

```bash
git fetch origin
git switch feat/multi-backend-langfuse-parity
git merge origin/main        # resolve conflicts (mostly in backends/aggregate/renderer)
pnpm typecheck && pnpm lint && pnpm test
git push
```

## Key design decisions

- **Canonical project id for cross-backend merge.** The three backends encode
  the same path differently (Claude: dash `-Users-x`; Kimi/Codex:
  `base64url(path)`). `Project.path` is the only stable cross-backend key
  (Claude's `decodePath` is lossy on dash-containing paths, but re-encoding a
  real path is deterministic). Merge on `canonicalProjectId(path)`; resolve back
  to native ids for per-backend session/detail queries.
- **Dashboard uses list-level data only.** Cost/precise latency live in
  per-session `SessionMetrics` (needs a deep parse each); iterating every
  session for the cross-session dashboard would be expensive. The dashboard
  aggregates cheap list data; cost/latency stay in the single-session timeline
  drill-down.
- **Aggregate views must route by data origin, not the active context.** A
  recurring architectural pitfall — see the reusable pattern notes kept in the
  author's knowledge base.
