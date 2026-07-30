# @openclaw/claude

OpenClaw harness plugin that delegates Anthropic-provider turns to a local
`@zeroaltitude/openclaw-claude-bridge` process via the codex-shaped JSON-RPC
protocol.

## Architecture

This package is the **in-tree client bridge** to an external JSON-RPC server.
Two pieces, two repos:

| Component                                    | Repo                        | Package                                |
| -------------------------------------------- | --------------------------- | -------------------------------------- |
| Client bridge (this package)                 | `openclaw/openclaw`         | `@openclaw/claude` (bundled extension) |
| **JSON-RPC server** (spawned by this bridge) | `openclaw/openclaw-plugins` | `@zeroaltitude/openclaw-claude-bridge` |

The directory name `src/app-server/` mirrors `extensions/codex/src/app-server/`
for visual symmetry with the codex extension. In both cases the directory
holds the **client side** of the codex-app-server protocol; the actual
server is an external binary spawned over stdio. Codex's server is
`@openai/codex` (third-party); ours is `@zeroaltitude/openclaw-claude-bridge`
(fork-preview publish path; will migrate to `@openclaw/openclaw-claude-bridge`
once the upstream PR lands and maintainers republish).

## Runtime dependency on the server

This bridge spawns `openclaw-claude-bridge` (the binary published by
[`@zeroaltitude/openclaw-claude-bridge`](https://www.npmjs.com/package/@zeroaltitude/openclaw-claude-bridge))
at turn-start. The server package is declared as a regular dependency in
`extensions/claude/package.json`, so installing `@openclaw/claude` pulls
the binary into `node_modules/.bin/openclaw-claude-bridge`
automatically — no separate install step needed.

The `@zeroaltitude` scope is a fork-preview publish path. Once the
upstream OpenClaw PR lands and maintainers republish under
`@openclaw/openclaw-claude-bridge`, this dependency will switch to the
`@openclaw` scope in a future patch.

If a turn fails with `claude-bridge is not initialized` or
`spawn openclaw-claude-bridge ENOENT`, the most likely cause is a
broken install — confirm `which openclaw-claude-bridge` (or
`ls node_modules/.bin/openclaw-claude-bridge` from the OpenClaw
checkout root) returns a path before debugging further.

## Slash commands

This extension registers `/claude` with subcommands:

- `/claude status` — shared-client liveness + last server stderr
- `/claude version` — bridge + installed server package versions
- `/claude threads` — the active session's thread binding (SQLite plugin state)
- `/claude resume <thread_id>` — rotate the session's binding to a specific thread
- `/claude help` — subcommand listing (default when no args)

## Hot-path features

- **Rate-limit surfacing** (server-side): Anthropic 429 metadata is parsed
  and folded into the user-visible error message (server's `rate-limits.ts`).
- **Image payload sanitizer** (server-side): pre-flight validates image
  content blocks against Anthropic's 5 MB / 100-images-per-request limits
  before they hit the API (server's `image-payload-sanitizer.ts`).
- **Plugin inventory + thread config** (server-side): captures plugin tool
  inventories per thread so resume can detect catalog drift (server's
  `plugin-inventory.ts` + `plugin-thread-config.ts`).
- **Vision tools filter** (bridge-side): when the model has native vision
  AND the turn carries inbound images, the redundant `image` tool is
  filtered out (`src/app-server/vision-tools.ts`).
- **Doctor contract** (bridge-side): legacy-config rules and session-route
  ownership consumed by `openclaw doctor` (`doctor-contract-api.ts`).
- **Event projection** (bridge-side): item/started/completed and
  assistant/reasoning deltas are projected into the OpenClaw harness's
  notification + accumulator surface via `src/app-server/event-projector.ts`,
  decoupling the JSON-RPC event shape from `run-attempt.ts`.
- **Transcript mirroring** (bridge-side): turn output is mirrored into the
  OpenClaw session transcript with stable `claude/${threadId}/${turnId}/...`
  idempotency keys; replays and crash recovery skip already-appended entries
  (`src/app-server/transcript-mirror.ts`).
- **Aggregate tool-result cap** (bridge-side): dynamic-tool output is
  budgeted across all text blocks in a single result (not per-block); the
  cap reads from `agents.list[].contextLimits.toolResultMaxChars` with
  fallback to `agents.defaults.contextLimits.toolResultMaxChars` and then
  to the 16 000-char default (`src/app-server/dynamic-tools.ts`).

## Codex parity status

This bridge mirrors the codex extension's architecture so reasoning
about either is reasoning about both. The status table below splits
parity into three buckets so temporary gaps aren't mistaken for
permanent limitations, and permanent SDK surface differences aren't
treated as endless TODOs.

### Implemented parity

- **Three-piece architecture** — in-tree bridge + plugin manifest +
  external JSON-RPC server, mirroring codex.
- **JSON-RPC over stdio** — same wire shape as
  `@openai/codex`'s app-server protocol.
- **Doctor contract** — `doctor-contract-api.ts` exports the
  legacy-config rules and session-route ownership facts
  `openclaw doctor` consumes.
- **`/claude` slash commands** — `status`, `version`, `threads`,
  `resume`, `help`.
- **Rate-limit surfacing**, **image payload sanitizer**, **plugin
  inventory + thread config fingerprint** — all server-side; see
  "Hot-path features" above.
- **Guardian / requirements approval+sandbox floor** — the bridge's
  default `appServer.approvalPolicy` / `appServer.sandbox` are DERIVED
  (mirroring codex's `resolveCodexAppServerRuntimeOptions`) from core
  `tools.exec.{mode,security,ask}` plus an enterprise requirements floor,
  instead of a static `never` / `danger-full-access`. See
  `src/app-server/policy.ts`. Resolution precedence: explicit
  `appServer.approvalPolicy` / `appServer.sandbox` config →
  `OPENCLAW_CLAUDE_APP_SERVER_APPROVAL_POLICY` env → requirements/exec
  guardian default → implicit yolo default. With no exec policy and no
  requirements file the prior permissive default is preserved.
  - Requirements floor path (TOML; same schema keys as codex —
    `allowed_approval_policies`, `allowed_sandbox_modes`, and
    `[[remote_sandbox_config]]` host-glob blocks):
    - Unix: `/etc/openclaw-claude/requirements.toml`
    - Windows: `%ProgramData%\OpenClaw\Claude\requirements.toml`
    - Override via `OPENCLAW_CLAUDE_APP_SERVER_REQUIREMENTS`.
  - The codex-intrinsic `approvalsReviewer` / model-backed-reviewer /
    `guardian_subagent` machinery is OMITTED — the Claude protocol has
    no reviewer equivalent; the floor resolves only `approvalPolicy` +
    `sandbox`.
- **Vision-tools filter** — bridge-side strip of redundant `image`
  tool when the model has native vision.
- **Event projection** — codex-style item/started + item/completed
  - delta accumulator extracted into
    `src/app-server/event-projector.ts`.
- **Transcript mirroring** — `src/app-server/transcript-mirror.ts`
  appends turn output with stable
  `claude/${threadId}/${turnId}/...` idempotency keys; replays /
  crash recovery skip already-appended entries.
- **Aggregate `toolResultMaxChars` budgeting** — reads from
  `agents.list[].contextLimits.toolResultMaxChars` with fallback
  to `agents.defaults`, default 16 000 chars; budget runs across
  all text blocks in a single tool result, matching codex's
  `convertToolContents` algorithm.
- **Zod-validated protocol boundaries** — `protocol-validators.ts`
  enforces shape on inbound notifications + outbound requests.
- **Tool-result middleware** — `createAgentToolResultMiddlewareRunner({ runtime: "claude" })`
  is wired into the bridge so plugins can register tool-result
  middlewares scoped to claude.
- **Messaging source-reply telemetry** —
  `messagingToolSourceReplyPayloads` is captured and forwarded
  through `ClaudeDynamicToolTelemetry`, matching codex's
  source-reply attribution path.
- **`thread/fork` for catalog drift** — when the dynamic-tool
  catalog changes mid-session, the bridge calls `thread/fork`
  (with new tools + fingerprint as overrides) instead of
  `thread/start`. The server's fork handler copies the parent's
  `messages.jsonl` so transcript continuity is preserved across
  the rotation.
- **Legacy state migration** — first launch auto-renames the
  pre-rename `~/.openclaw/state/claude-app-server` dir to
  `~/.openclaw/state/claude-bridge`.
- **Real-runtime proof script** —
  `src/app-server/bridge.live.test.ts` (gated by
  `OPENCLAW_LIVE_TEST=1`) covers spawn / initialize / thread
  lifecycle / mirror replay; with `ANTHROPIC_API_KEY` set it also
  exercises a real dynamic-tool round-trip and a real approval
  request.

### Planned bridge work

- **Scope migration** — `@zeroaltitude/openclaw-claude-bridge` is a
  fork-preview publish path. Once the upstream OpenClaw PR lands
  and maintainers republish under `@openclaw/openclaw-claude-bridge`,
  this package's dependency declaration switches.

- **Server-side deferred-loading runtime** — the bridge spec type
  carries `namespace` + `deferLoading` flags (see
  `extensions/claude/src/app-server/types.ts:DynamicToolSpec` and
  `createClaudeDynamicToolBridge({ loading: "searchable" })`), but
  the server's MCP layer registers every tool eagerly regardless.
  To actually skip eager registration, the server needs either
  SDK-side deferred-loading support (see SDK differences below) or
  a search-meta-tool that exposes deferred tools on demand.

### True SDK surface differences

These are gaps in the Anthropic `@anthropic-ai/claude-agent-sdk`
itself; the bridge cannot close them without an SDK change. Listed
here so they aren't relitigated as bridge bugs.

- **MCP registration is set at thread-start and not refreshable
  on resume.** This is why catalog drift requires `thread/fork`
  (which creates a new SDK session) instead of an in-place
  `thread/resume`. Codex's app-server doesn't have this
  constraint because the OpenAI SDK handles tool refresh
  differently.

- **No native deferred-loading or namespaced tool routing.**
  Codex's OpenAI SDK natively understands `deferLoading: true` and
  namespaced tool addressing (`<namespace>.<name>`) so it can
  defer tool loading until the agent searches for them. The
  Anthropic SDK loads all MCP-registered tools eagerly. Until
  this changes (or the server grows a search-meta-tool), the
  `loading: "searchable"` mode flows the metadata through the
  protocol but doesn't actually defer registration.

- **No native source-reply delivery mode plumbing.** Codex's app
  server exposes a `sourceReplyDeliveryMode` setting that
  influences how messaging-tool outputs get routed. The Anthropic
  SDK has no equivalent surface; the bridge captures the
  source-reply payload in telemetry (so OpenClaw's outbound
  pipeline can use it) but cannot honor a per-thread delivery-mode
  contract end-to-end inside the SDK.
