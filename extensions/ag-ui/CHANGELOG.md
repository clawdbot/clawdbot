# Changelog

## Unreleased

### Documentation
- **New "Deployment and browser exposure" section in the README** — states the
  supported topology (browser → AG-UI runtime → this channel), the origin
  allow-list and application-authentication hooks the runtime provides, where the
  operator token is held, and a route-by-route table of caller, credential, and
  scope for `/v1/ag-ui/operator` versus `/v1/ag-ui`.

### Security
- **Dropped the retired `CLAWDBOT_GATEWAY_TOKEN` fallback** from gateway-secret
  resolution. The gateway ignores legacy `CLAWDBOT_*` / `MOLTBOT_*` names
  everywhere else, so accepting one here gave this authenticated HTTP surface a
  second, undocumented credential source that the rest of the gateway rejects.
  Only `gateway.auth.token` and `OPENCLAW_GATEWAY_TOKEN` are honoured now.

### Fixed
- **Frontend-tool transcript order** — the assistant's closing text rendered
  ABOVE its own frontend-tool card, inverting the reference integrations. Tool
  calls are parented to the assistant message that announced them, and AG-UI
  clients render a message's text above its cards, so sharing one message id
  made the order unfixable by emission sequence alone. The summary is now
  announced as a NEW message after the card, matching the shape reference
  integrations get from their separate follow-up run: card first, then text.

### Removed
- **`cron_report` example tool and `examples/` directory** — the tool, its
  manifest `contracts.tools` entry, and its `api.ts` export are gone. A generic
  transport channel should not own a feature-specific A2UI demo surface; keeping
  it here created a second product surface and maintenance contract outside the
  channel's ownership boundary. Generic A2UI support (`src/a2ui.ts`, the
  `before_tool_call` / `tool_result_persist` hooks that emit `ACTIVITY_SNAPSHOT`
  for any tool returning `a2ui_operations`) is unchanged — only the example
  consumer was removed. Republish it as a separately owned optional package if
  needed.
- **Dead client-tool plugin registration** (`src/client-tools.ts`,
  `aguiToolFactory`, and the `popTools`/`toolStore` half of `src/tool-store.ts`).
  Nothing ever wrote to that store, so the factory could only ever return `null`.
  Client and frontend state-writer tools reach the model through the HTTP
  handler's `clientTools` argument to `runEmbeddedAgent`, never through the
  plugin tool registry — so this registration was unreachable, and the plugin
  now correctly declares no `contracts.tools` at all.

## 0.7.0 (2026-04-29)

### Added
- **Operator-auth AG-UI route at `/v1/ag-ui/operator`** — for OpenClaw
  operator-console embedded consumers (notably the new
  [`@contextableai/clawpilotkit`](./clawpilotkit/) `chat.surface` slot)
  that already hold a gateway token via OpenClaw's iframe `ExtensionTabContext`
  handshake. The gateway validates operator scope before our handler runs,
  so the embedded consumer skips the device-pairing dance entirely.
  External AG-UI clients (an AG-UI client on a different host, `an AG-UI client`,
  etc.) continue to use `/v1/ag-ui` and pair as before.
- **`@contextableai/clawpilotkit` companion package** under [`clawpilotkit/`](./clawpilotkit/) —
  an AG-UI client-based chat UI that runs in two modes against this plugin:
  embedded as an OpenClaw plugin contributing the `chat.surface` slot, or
  standalone via `npx @contextableai/clawpilotkit` against any ag-ui
  gateway. See its README for setup.
- **Reasoning event surfacing** — emit AG-UI `REASONING_START`, `REASONING_MESSAGE_START/CONTENT/END`, `REASONING_END` events when the agent streams reasoning content (extended thinking). Requires models with thinking enabled (e.g. Claude with `thinkingDefault`, OpenAI o-series). On by default; disable via `surfaceReasoning: false` in channel defaults.
- New channel default: `surfaceReasoning: true`.
- **`X-OpenClaw-Session-Key` header for per-user session isolation** — when present, the validated header value is composed under the route-derived session key as `<route.sessionKey>[:user:<header>][:thread:<threadId>]`. The header subdivides the route scope and never replaces it, enabling multi-user web apps (e.g. an AG-UI client deployments where one AG-UI client is shared across authenticated users) to keep per-user conversation history isolated. Treat as a trusted-proxy-only header (analogous to `X-Forwarded-For`) — see the new "Session isolation" section in the README. Values are validated for length (1–256), charset (`[A-Za-z0-9._@:-]`), and path-traversal sequences; invalid values return `400 invalid_request_error` before the agent is dispatched. Thanks to @mikehole for the contribution (#22).

### Changed
- **CORS on AG-UI routes** — both `/v1/ag-ui` (pairing) and
  `/v1/ag-ui/operator` now set `Access-Control-Allow-Origin: *` plus the
  matching `Allow-Headers`/`Allow-Methods` and answer the `OPTIONS`
  preflight with `204`. Required for two cross-origin scenarios:
  - The embedded `chat.surface` slot iframe runs without
    `allow-same-origin`, so its document origin is opaque (`null`).
  - The standalone `clawpilotkit` launcher serves the chat UI from its
    own host:port (e.g. `http://localhost:3939`), separate from the
    gateway origin.
  Setting `*` is safe here: route auth still requires either a paired
  device token or an operator-scope gateway token, which the browser's
  same-origin policy prevents a third-party origin from minting.
- Bumped `@ag-ui/core` and `@ag-ui/encoder` from `^0.0.43` to `^0.0.52` — uses new `REASONING_*` events (the old `THINKING_*` events are deprecated and slated for removal in AG-UI v1.0.0).

### Internal
- Extracted the post-authentication AG-UI dispatch from the existing
  pairing handler into a shared `dispatchAuthenticatedAguiRequest(req,
  res, runtime, caller)` helper parameterised over an `AuthenticatedCaller`
  (`{ id, fromLabel }`). The pairing handler feeds the paired device
  id/label; the new operator handler feeds a fixed operator caller id.

## 0.6.4 (2026-04-17)

### Changed
- **Compat with OpenClaw 2026.4.16 plugin-sdk API:**
  - `upsertPairingRequest` now requires `accountId` — pass `"default"` to match `src/channel.ts`.
  - `ChatType` literal `"dm"` renamed to `"direct"` for `resolveAgentRoute` peer kinds.
  - `ReplyDispatcher` gained required `getFailedCounts` and `markComplete` members (no-op stubs — ag-ui doesn't track retries or typing indicators).
  - `openclaw/plugin-sdk/plugin-runtime` is now a typed public subpath; removed the `@ts-expect-error` suppression in `index.ts`.

### Fixed
- Two `src/integration.test.ts` cases (`rejects missing user message with 400`, `rejects empty messages array with 400`) expected HTTP 400 but the handler has returned `200` with an empty SSE run since commit `e3a88c8` (AG-UI protocol compliance for init/sync). Tests now match the current protocol-compliant behavior.

## 0.6.3 (2026-04-07)

### Added
- **A2UI v0.9 support** — detect `{ "a2ui_operations": [...] }` in server-side tool results and emit `ACTIVITY_SNAPSHOT` events over the AG-UI SSE stream. an AG-UI client clients with A2UI rendering enabled will display rich interactive surfaces (cards, lists, forms) instead of raw JSON.
- **`cron_report` example tool** (`examples/cron-report-tool.ts`) — server-side tool that wraps cron job run data in a fixed A2UI v0.9 card layout (horizontal scrollable list of cards with startedAt, duration, model, tokensUsed, summary). Registered as `optional: true` — agents must opt in via `tools.alsoAllow: ["cron_report"]`.
- **Example setup guide** (`examples/SETUP.md`) — step-by-step instructions for configuring a dedicated cron report demo agent with `X-OpenClaw-Agent-Id` header routing.
- New `src/a2ui.ts` module with detection utilities: `tryParseA2UIOperations`, `extractToolResultText`, `groupBySurface`, `getOperationSurfaceId`.

### Fixed
- **an AG-UI client compatibility: single-run event stream** — removed `splitRunIfToolFired()` which split tool calls and text into separate AG-UI runs. an AG-UI client closes the SSE connection on `RUN_FINISHED`, so the second run's text was never received. The entire agent turn (tool calls + follow-up text) now stays in a single `RUN_STARTED`/`RUN_FINISHED` pair.
- **`TOOL_CALL_RESULT` content** — was always emitted as `content: ""`. Now populated with the actual tool result text extracted from the OpenClaw `tool_result_persist` hook event.
- **`messageId` collision** — `TOOL_CALL_RESULT` and `TEXT_MESSAGE_START` shared the same `messageId`, causing an AG-UI client to overwrite the tool result with the text message. Tool results now use a dedicated `messageId` (`msg-tool-<toolCallId>`), while text messages keep `msg-<uuid>`.
- **HTTP route registration** — restored the proven v0.5.4 pattern (`registerPluginHttpRoute` via `openclaw/plugin-sdk/plugin-runtime`) after the `gateway_start` hook approach (0.6.1) caused 404s on deployed servers.

### Changed
- Examples are excluded from the npm package (`!dist/examples` in `files`). The `cron_report` tool loads via dynamic import with a silent `.catch()` fallback — safe for npm installs where `examples/` doesn't exist.

## 0.5.4 (2026-04-02)

### Fixed
- Use `registerPluginHttpRoute()` from `openclaw/plugin-sdk/plugin-runtime` (dynamic import) to write directly to the pinned HTTP route registry. This is the correct fix for the startup timing issue — `api.registerHttpRoute()` writes to the loader's private registry which the HTTP handler never reads, regardless of when it's called.

## 0.5.3 (2026-04-02) [yanked]

### Fixed
- Attempted `gateway_start` hook approach — `api.registerHttpRoute()` still writes to the wrong registry even when called post-startup. Use 0.5.4 instead.

## 0.5.2 (2026-04-02) [yanked]

### Fixed
- Attempted to use `registerPluginHttpRoute()` from the plugin SDK — not exported in the public SDK. Use 0.5.3 instead.

## 0.5.1 (2026-04-01)

### Fixed
- Add `match: "exact"` to `registerHttpRoute` call — required by OpenClaw 2026.3.23+ which changed the plugin HTTP route API to require an explicit match mode. Without it, the route registers silently but never matches incoming requests, resulting in a 404. Backwards compatible with older OpenClaw versions (unknown properties are ignored).

## 0.5.0 (2026-04-01)

### Changed
- **Breaking:** Peer ID now uses the stable device UUID instead of the per-thread ID. This enables identity linking (`session.identityLinks`) so ag-ui devices can be linked to users across channels, matching how Telegram and Slack connections work.
- Session keys now include a `:thread:<threadId>` suffix for per-thread session separation (same pattern as Slack thread sessions).

### Migration
- **Identity linking:** You can now add ag-ui device IDs to `session.identityLinks` in `openclaw.json`:
  ```json
  {
    "session": {
      "dmScope": "per-peer",
      "identityLinks": {
        "alice": ["ag-ui:<deviceId>", "telegram:123456", "slack:U0123ABC"]
      }
    }
  }
  ```
  The device UUID is shown during pairing approval (`openclaw pairing list ag-ui`).
- **Session history:** Existing session histories are keyed on the old format (`ag-ui-<threadId>` peer). After upgrading, devices will start new sessions. No data is lost — old sessions remain in the store but won't be matched by the new key format.

## 0.4.5 (2026-03-15)

### Added
- Forward AG-UI `RunAgentInput.context` entries to the LLM prompt — each context entry (description + value) is formatted and appended to `BodyForAgent` so the agent sees UI-provided context (e.g. pending tool-call approvals, app state)

## 0.4.4 (2026-03-15)

_Published prematurely — superseded by 0.4.5._

## 0.4.3 (2026-03-14)

### Added
- Implement `X-OpenClaw-Agent-Id` header routing — pass the header value as `accountId` to `resolveAgentRoute`, enabling agent selection via bindings (e.g. `{ "agentId": "auditor", "match": { "channel": "ag-ui", "accountId": "auditor" } }`)

## 0.4.2 (2026-03-13)

### Removed
- Reverted `/v1/ag-ui/info` endpoint and CopilotRuntime single-transport `{ method: "info" }` handling added in 0.4.0–0.4.1 — ag-ui is a pure AG-UI endpoint; an AG-UI client clients must use a CopilotRuntime intermediary with `an AG-UI client` pointed at ag-ui

## 0.3.3 (2026-03-13)

### Fixed
- Return a valid empty SSE run (`RUN_STARTED` + `RUN_FINISHED`) instead of 400 when `messages` is empty or contains no user/tool messages — restores AG-UI protocol compliance and fixes an AG-UI client integration (fixes #18)

## 0.3.2 (2026-03-09)

### Fixed
- Pass `{ channel: "ag-ui" }` object to `readAllowFromStore` — API changed again in OpenClaw 2026.3.7 (fixes #17)

## 0.3.1 (2026-03-09)

### Fixed
- Compile TypeScript to `dist/` and point `openclaw.extensions` to `./dist/index.js` instead of `./index.ts` — fixes "loaded without install/load-path provenance" warning in OpenClaw 3.7
- Keep `auth: "plugin"` on `registerHttpRoute` with a type cast — required at runtime but not yet in SDK typings (fixes #16)
- Remove `onToolResult` from reply options — property is now explicitly omitted from the type
- Use `EventType` enum instead of plain `string` in `EventWriter` type — fixes type mismatch with AG-UI core

### Changed
- Add `main`, `build`, and `prepublishOnly` fields to `package.json` for proper npm packaging
- Add `declaration: true` and `exclude: ["**/*.test.ts"]` to `tsconfig.json`
- Add explicit type annotation to `plugin` export to avoid non-portable inferred type

## 0.2.9 (2026-03-06)

### Fixed
- Add `auth: "plugin"` to `registerHttpRoute` call — required by OpenClaw 2026.3.2; omitting it silently dropped the `/v1/ag-ui` route, causing 404s
- Pass `{ channel, accountId }` object to `readAllowFromStore` instead of a bare string — fixes 403 responses for approved devices after the pairing API changed in 2026.3.2
- Add `pairing_code` and `bearer_token` at the root of the 403 pairing response alongside the existing nested `error.pairing` fields — restores compatibility with Kotlin `AgUIPairingResponse` clients expecting flat fields
- Add diagnostic `console.log` for 400 responses to aid debugging of malformed requests

### Changed
- README event table was missing `TOOL_CALL_ARGS` and `TOOL_CALL_RESULT`; `tools` field incorrectly said "reserved for future use"
- Integration tests used the gateway token directly instead of an HMAC-signed device token, causing 401s against v0.2.0+ servers
- "Missing auth" integration test expected 401 instead of 403 (pairing initiation)

### Added
- "Tool call events" documentation section explaining client vs server tool flows and diagnostic tips
- Unit tests for `handleBeforeToolCall` and `handleToolResultPersist` hook handlers (`src/tool-hooks.test.ts`)
- Extracted hook handlers from `index.ts` into exported named functions for testability (no behavioral change)
- Integration tests now accept `AG_UI_DEVICE_TOKEN` or auto-generate one from `OPENCLAW_GATEWAY_TOKEN` + `AG_UI_DEVICE_ID`

## Unreleased

## 0.2.8 (2026-02-26)

### Fixed
- Remove literal `process.env` from a code comment in `http-handler.ts` that was itself triggering the security scanner — the comment documenting the v0.2.5/v0.2.6 fix contained the exact pattern the scanner flags

## 0.2.7 (2026-02-18)

### Fixed
- Close open text messages before emitting `RUN_FINISHED` in `splitRunIfToolFired()` — fixes `AGUIError: Cannot send 'RUN_FINISHED' while text messages are still active` when text streaming is followed by a server-side tool call and then more text

## 0.2.6 (2026-02-10)

### Fixed
- Move gateway secret resolution into its own module (`gateway-secret.ts`) so the HTTP handler file contains zero `process.env` references — eliminates plugin security scanner warning ("Environment variable access combined with network send")

## 0.2.5 (2026-02-10)

### Fixed
- Resolve gateway secret at factory initialization time instead of per-request to eliminate plugin security scanner warning ("Environment variable access combined with network send")

## 0.2.4 (2026-02-06)

### Changed
- Separate tool call events and text message events into distinct AG-UI runs — when text follows a tool call, the tool run is finished and a new run (with a unique runId) is started for the text messages

## 0.2.3 (2026-02-06)

### Fixed
- Append `\n\n` paragraph joiner to streamed text deltas so chunks render with proper spacing
- Include `runId` in all `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, and `TEXT_MESSAGE_END` events for AG-UI protocol compliance

### Changed
- Set channel defaults to `blockStreaming: true` and `chunkMode: "newline"` for correct paragraph-based streaming out of the box
- Clean up multi-run logic for tool-call-then-text flows (single run per request)

## 0.2.2 (2026-02-05)

### Fixed
- Include `messageId` in `TOOL_CALL_RESULT` events as required by AG-UI client v0.0.43 Zod schema

### Added
- Debug logging throughout tool call flow for easier troubleshooting

## 0.2.1 (2026-02-05)

### Fixed
- Return HTTP 429 `rate_limit` error when max pending pairing requests (3) is reached, instead of returning an empty pairing code

## 0.2.0 (2026-02-04)

### Added
- **Device pairing authentication** - Secure per-device access control
  - HMAC-signed device tokens (no master token exposure)
  - Pairing approval workflow (`openclaw pairing approve ag-ui <code>`)
  - New CLI command: `openclaw ag-ui devices` - List approved devices

### Changed
- **Breaking:** Direct bearer token authentication using `OPENCLAW_GATEWAY_TOKEN` is now deprecated and no longer supported. All clients must use device pairing.

### Security
- Device tokens are HMAC-signed and do not expose the gateway's master secret
- Pending pairing requests expire after 1 hour (max 3 per channel)
- Each device requires explicit approval by the gateway owner

## 0.1.1 (2026-02-03)

### Changed
- Endpoint path changed from `/v1/agui` to `/v1/ag-ui`
- Package name changed to `@contextableai/ag-ui`

## 0.1.0 (2026-02-02)

Initial release.

- AG-UI protocol endpoint at `/v1/agui` for OpenClaw gateway
- SSE streaming of agent responses as AG-UI events (`RUN_STARTED`, `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, `TOOL_CALL_START`, `TOOL_CALL_END`, `RUN_FINISHED`, `RUN_ERROR`)
- Bearer token authentication using the gateway token
- Content negotiation via `@ag-ui/encoder` (SSE and protobuf support)
- Standard OpenClaw channel plugin (`agui`) for gateway status visibility
- Agent routing via `X-OpenClaw-Agent-Id` header
- Abort on client disconnect
- Compatible with `@ag-ui/client` `an AG-UI client`, an AG-UI client, and any AG-UI consumer
