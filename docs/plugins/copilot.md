---
summary: "Run OpenClaw embedded agent turns through the external GitHub Copilot SDK harness"
title: "Copilot SDK harness"
read_when:
  - You want to use the GitHub Copilot SDK harness for an agent
  - You need configuration examples for the `copilot` runtime
  - You are wiring an agent to subscription Copilot (github / openclaw / copilot) and want it to run through the Copilot CLI
---

The external `@openclaw/copilot` plugin runs embedded subscription Copilot
agent turns through the GitHub Copilot CLI (`@github/copilot-sdk`) instead of
OpenClaw's built-in harness. The Copilot CLI session owns the low-level
agent loop: native tool execution, native compaction (`infiniteSessions`), and
CLI-managed thread state under `copilotHome`. OpenClaw still owns chat
channels, session files, model selection, dynamic tools (bridged), approvals,
media delivery, the visible transcript mirror, `/btw` side questions (see
[Side questions (`/btw`)](#side-questions-btw)), and `openclaw doctor`.

For the broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes).

## Requirements

- OpenClaw with the `@openclaw/copilot` plugin installed.
- If your config uses `plugins.allow`, include `copilot` (the manifest id the
  plugin declares). An allowlist entry for the npm package name
  `@openclaw/copilot` will not match and leaves the plugin blocked, even with
  `agentRuntime.id: "copilot"` set.
- A GitHub Copilot subscription that can drive the Copilot CLI, or a
  `gitHubToken` env var / auth-profile entry for headless or cron runs.
- A writable `copilotHome` directory. Defaults to `<agentDir>/copilot` when
  OpenClaw provides an agent directory, otherwise
  `~/.openclaw/agents/<agentId>/copilot`.

`openclaw doctor` runs the plugin's [doctor contract](#doctor) for
session-state ownership and future config migrations. It does not probe the
Copilot CLI environment.

## Install

The Copilot runtime ships as an external plugin so the core `openclaw`
package does not carry `@github/copilot-sdk` or its platform-specific
`@github/copilot-<platform>-<arch>` CLI binary (roughly 260 MB together).
Install it only for agents that opt into this runtime:

```bash
openclaw plugins install @openclaw/copilot
```

The setup wizard installs the plugin automatically the first time you select
a `github-copilot/*` model **and** your config routes that model (or its
provider) to the Copilot runtime via `agentRuntime: { id: "copilot" }`; see
[Quickstart](#quickstart). Without that opt-in, OpenClaw uses its built-in
GitHub Copilot provider and never installs this plugin.

The runtime resolves the SDK in this order:

1. `import("@github/copilot-sdk")` from the installed `@openclaw/copilot`
   package.
2. The fallback dir `~/.openclaw/npm-runtime/copilot/` (legacy on-demand
   install target).

A missing SDK surfaces one error with code `COPILOT_SDK_MISSING` and the
reinstall command above.

## Quickstart

Pin one model (or one provider) to the harness:

```json5
{
  agents: {
    defaults: {
      model: "github-copilot/auto",
      models: {
        "github-copilot/auto": {
          agentRuntime: { id: "copilot" },
        },
      },
    },
  },
}
```

Set `agentRuntime.id` on a single model entry to route only that model through
the harness, or on a provider to route every model under that provider.

`github-copilot/auto` is the portable starting point. Named Copilot models are
account- and organization-policy-dependent; confirm your authenticated
Copilot CLI actually exposes a model before pinning it.

## Supported providers

The harness supports the canonical `github-copilot` provider (owned by
`extensions/github-copilot`), plus custom `models.providers` entries when the
model has a non-empty `baseUrl` and one of these `api` shapes:

- `anthropic-messages`
- `azure-openai-responses`
- `ollama` (OpenAI-compatible completions)
- `openai-completions`
- `openai-responses`

Native provider ids (`openai`, `anthropic`, `google`, `ollama`) stay owned by
their native runtimes. Use a distinct custom provider id to route an endpoint
through Copilot BYOK instead.

Copilot BYOK endpoints must be public HTTPS URLs. The harness gives the
Copilot SDK a per-attempt loopback proxy, then forwards provider traffic
through OpenClaw's guarded fetch path so DNS pinning and SSRF policy stay
owned by OpenClaw. Use the native OpenClaw runtime for local Ollama, LM
Studio, or LAN model servers.

## BYOK

Copilot BYOK uses the SDK's session-level custom provider contract. OpenClaw
passes the resolved model endpoint, API key, bearer-token mode, headers, model
id, and context/output limits; provider transport logic stays in the SDK, not
core.

```json5
{
  agents: {
    defaults: {
      model: "custom-proxy/llama-3.1-8b",
      models: {
        "custom-proxy/llama-3.1-8b": {
          agentRuntime: { id: "copilot" },
        },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "https://api.example.com/v1",
        apiKey: "${CUSTOM_PROXY_API_KEY}",
        api: "openai-responses",
        authHeader: true,
        models: [{ id: "llama-3.1-8b", name: "Llama 3.1 8B" }],
      },
    },
  },
}
```

BYOK sessions are keyed separately from subscription sessions and from other
BYOK endpoints or credentials. Rotating the key, headers, model, or endpoint
starts a fresh Copilot SDK session instead of resuming incompatible state.

## Auth

Precedence, applied per agent during `runCopilotAttempt`:

1. **Explicit `useLoggedInUser: true`** on the attempt input — uses the
   Copilot CLI's logged-in user under the agent's `copilotHome`.
2. **Explicit `gitHubToken`** on the attempt input (requires `profileId` +
   `profileVersion`). For direct CLI invocations and tests that need to
   bypass auth-profile resolution.
3. **Contract-resolved `resolvedApiKey` + `authProfileId`** — the production
   main path. Core resolves the agent's configured `github-copilot` auth
   profile (`src/infra/provider-usage.auth.ts:resolveProviderAuths`) before
   invoking the harness, so a `github-copilot:<profile>` auth profile works
   end-to-end for headless, cron, or multi-profile setups without env vars.
4. **Env-var fallback**, checked in this order (first non-empty value wins,
   empty strings count as absent; mirrors the shipped `github-copilot`
   provider precedence in `extensions/github-copilot/auth.ts`):
   1. `OPENCLAW_GITHUB_TOKEN` — harness-specific override; lets you pin a
      token for the OpenClaw harness without disturbing system-wide `gh` /
      Copilot CLI config.
   2. `COPILOT_GITHUB_TOKEN` — standard Copilot SDK / CLI env var.
   3. `GH_TOKEN` — standard `gh` CLI env var.
   4. `GITHUB_TOKEN` — generic GitHub token fallback.

   The synthesized pool profile id is `env:<NAME>`; the profile version is a
   non-reversible sha256 fingerprint of the token, so rotating the env value
   busts the client pool cleanly.

5. **Default `useLoggedInUser`** when no token signal is available.

Each agent gets its own `copilotHome` so Copilot CLI tokens, sessions, and
config never leak between agents on the same machine. Default:
`<agentDir>/copilot` (keeps SDK state out of the same directory as
OpenClaw's `models.json` / `auth-profiles.json`), or
`~/.openclaw/agents/<agentId>/copilot` when no agent directory is supplied.
Override with `copilotHome: <path>` on the attempt input for a custom
location (for example, a shared mount for migration).

Live harness tests use `OPENCLAW_COPILOT_AGENT_LIVE_TOKEN` for a direct
token. The shared live-test setup scrubs `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
and `GITHUB_TOKEN` after staging real auth profiles into the isolated test
home, so a `gh auth token` value passed through the dedicated variable avoids
false skips without leaking into unrelated suites.

## Configuration surface

The harness reads config from per-attempt input (`runCopilotAttempt({...})`)
plus a small set of env defaults inside `extensions/copilot/src/`:

| Field                    | Purpose                                                                                                                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilotHome`            | Per-agent CLI state directory (defaults above).                                                                                                                                                                                                                                                 |
| `model`                  | String or `{ provider, id, api?, baseUrl?, headers?, authHeader? }`. Omit to use the agent's normal model selection; the harness verifies the resolved provider is supported.                                                                                                                   |
| `reasoningEffort`        | `"low" \| "medium" \| "high" \| "xhigh"`. Maps from OpenClaw's `ThinkLevel` / `ReasoningLevel` resolution in `auto-reply/thinking.ts`.                                                                                                                                                          |
| `infiniteSessionConfig`  | Optional override for the SDK `infiniteSessions` block driven by `harness.compact`. Safe to leave as-is.                                                                                                                                                                                        |
| `hooksConfig`            | Optional native Copilot SDK `SessionHooks` config for tool/MCP, user-prompt, session, and error callbacks. Separate from OpenClaw's portable lifecycle hooks.                                                                                                                                   |
| `permissionPolicy`       | Optional override for the SDK's `onPermissionRequest` handler for built-in SDK tool kinds (`shell`, `write`, `read`, `url`, `mcp`, `memory`, `hook`). Defaults to `rejectAllPolicy` as a safety net; see [Permissions and ask_user](#permissions-and-ask_user) for why it never actually fires. |
| `enableSessionTelemetry` | Optional SDK session telemetry flag.                                                                                                                                                                                                                                                            |

OpenClaw plugin hooks need no Copilot-specific attempt configuration. The
harness runs `before_prompt_build` (and the legacy `before_agent_start`
compatibility hook), `llm_input`, `llm_output`, and `agent_end` through the
standard harness helpers. Successful SDK compactions also run
`before_compaction` and `after_compaction`. Bridged OpenClaw tools run
`before_tool_call` and report `after_tool_call`; `hooksConfig` remains for
native SDK-only callbacks with no portable equivalent.

Nothing else in OpenClaw needs to know about these fields. Other plugins,
channels, and core code see only the standard `AgentHarnessAttemptParams` /
`AgentHarnessAttemptResult` shape.

## Compaction

When `harness.compact` runs, the Copilot SDK harness:

1. Resumes the tracked SDK session without continuing pending work.
2. Calls the SDK's session-scoped history compaction RPC.
3. Returns the SDK compaction outcome without writing compatibility marker
   files under the workspace.

The OpenClaw-side transcript mirror (below) keeps receiving post-compaction
messages, so user-facing chat history stays consistent.

## Transcript mirroring

`runCopilotAttempt` dual-writes each turn's mirrorable messages into the
OpenClaw audit transcript via
`extensions/copilot/src/dual-write-transcripts.ts`. The mirror is scoped per
session (`copilot:${sessionId}`) and keyed per message
(`${role}:${sha256_16(role,content)}`), so re-emitted prior-turn entries
collide with existing on-disk keys instead of duplicating.

Two layers of failure containment wrap the mirror so a transcript write
failure never fails the attempt: an internal best-effort wrapper, plus a
defense-in-depth `.catch(...)` at the attempt level. Failures are logged, not
surfaced.

## Side questions (`/btw`)

`/btw` is **not** native on this harness. `createCopilotAgentHarness()`
deliberately leaves `harness.runSideQuestion` undefined
(asserted in `extensions/copilot/harness.test.ts`, `describe("runSideQuestion")`),
so OpenClaw's `/btw` dispatcher (`src/agents/btw.ts`) falls through to the
same path it uses for every non-Codex runtime: the configured model provider
is called directly with a short side-question prompt and streamed back via
`streamSimple` (no CLI session, no extra pool slot).

This keeps Copilot CLI sessions reserved for the agent's main turn loop, and
keeps `/btw` behavior identical to other non-Codex runtimes.

## Doctor

`extensions/copilot/doctor-contract-api.ts` is auto-loaded by
`src/plugins/doctor-contract-registry.ts`. It contributes:

- An empty `legacyConfigRules` (no retired fields yet).
- A no-op `normalizeCompatibilityConfig` (kept so future field retirements
  have a stable in-tree home).
- One `sessionRouteStateOwners` entry: provider `github-copilot`, runtime
  `copilot`, CLI session key `copilot`, auth profile prefix `github-copilot:`.

## Limitations

- The harness claims `github-copilot` plus unowned custom BYOK provider ids.
  Manifest-owned native provider ids stay on their owning runtime even when
  `agentRuntime.id` is forced to `copilot`.
- No TUI surface; PI's TUI remains the fallback for runtimes without a peer
  surface.
- PI session state does not migrate when an agent switches to `copilot`.
  Selection is per attempt; existing PI sessions remain valid.
- `ask_user` uses the provider-neutral gateway question runtime. The Control
  UI shows the same question card as other OpenClaw questions, supported
  channels render choice buttons, and the next queued plain-text message
  resolves that gateway record before the SDK request returns.

## Permissions and ask_user

Permission enforcement for bridged OpenClaw tools happens **inside the tool
wrapper**, not via the SDK's `onPermissionRequest` callback. The same
`wrapToolWithBeforeToolCallHook` that PI uses
(`src/agents/agent-tools.before-tool-call.ts`) is applied by
`createOpenClawCodingTools` to every coding tool: loop detection, trusted
plugin policies, before-tool-call hooks, and two-phase plugin approvals via
the gateway (`plugin.approval.request`) all run through the exact same code
path as native PI attempts.

Each SDK tool returned by the Copilot tool bridge is marked with:

- `overridesBuiltInTool: true` — replaces the Copilot CLI's built-in tool of
  the same name (edit, read, write, bash, ...) so every tool call routes back
  to OpenClaw.
- `skipPermission: true` — tells the SDK not to fire
  `onPermissionRequest({kind: "custom-tool"})` before invoking the tool. The
  wrapped `execute()` already performs the richer OpenClaw policy check; an
  SDK-level prompt would either short-circuit OpenClaw's enforcement
  (allow-all) or block every tool call (reject-all) — neither matches PI
  parity.

The in-tree Codex harness uses the same split: bridged OpenClaw tools are
wrapped (`extensions/codex/src/app-server/dynamic-tools.ts`) and the
codex-app-server's own native approval kinds
(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval`) route through `plugin.approval.request`
(`extensions/codex/src/app-server/approval-bridge.ts`). The Copilot SDK
equivalent — fail-closed `rejectAllPolicy` for any non-`custom-tool` kind
that ever reaches `onPermissionRequest` — is the same safety net, and it
never fires in practice because `overridesBuiltInTool: true` displaces every
built-in.

For the wrapped-tool layer to make policy decisions equivalent to PI, the
harness forwards the full PI attempt-tool context to
`createOpenClawCodingTools`: identity (`senderIsOwner`, `memberRoleIds`,
`ownerOnlyToolAllowlist`, ...), channel/routing (`groupId`,
`currentChannelId`, `replyToMode`, message-tool toggles), auth
(`authProfileStore`), run identity (`sessionKey` / `runSessionKey` derived
from `sandboxSessionKey`, `runId`), model context (`modelApi`,
`modelContextWindowTokens`, `modelCompat`, `modelHasVision`), and run hooks
(`onToolOutcome`, `onYield`). Without those fields, owner-only allowlists
silently deny by default, plugin-trust policies cannot resolve to the right
scope, and `session_status: "current"` resolves to a stale sandbox key. The
bridge builder is `extensions/copilot/src/tool-bridge.ts`, mirroring the PI
authoritative call at `src/agents/embedded-agent-runner/run/attempt.ts:1262`.
`runAttempt` resolves sandbox context through the shared
`resolveSandboxContext` seam, passes the SDK an effective working directory,
and forwards `sandbox` plus the subagent-spawn workspace into the tool
bridge. The bridge also forwards the bounded tool-construction controls it
can enforce at the SDK boundary: `includeCoreTools`, the runtime tool
allowlist, and `toolConstructionPlan`.

The bridge also uses the shared harness tool-surface helper from
`openclaw/plugin-sdk/agent-harness-tool-runtime` for PI parity. When
tool-search is enabled, the SDK sees compact control tools plus a hidden
catalog executor instead of every OpenClaw tool schema. When code mode is
enabled, the helper builds the same code-mode control surface and catalog
lifecycle used by other agent harnesses. Local-model lean defaults,
runtime-compatible schema filtering, directory hydration, and catalog
cleanup all stay in the shared helper so Copilot and Codex-adjacent
harnesses do not drift.

### Session-level GitHub token

The Copilot SDK contract distinguishes the **client-level** GitHub token
(`CopilotClientOptions.gitHubToken`, authenticates the CLI process itself)
from the **session-level** token (`SessionConfig.gitHubToken`, determines
content exclusion, model routing, and quota for that session; honored on
both `createSession` and `resumeSession`). The harness resolves auth once via
`resolveCopilotAuth` and sets both fields when the auth mode is `gitHubToken`
(an explicit `auth.gitHubToken` or a contract-resolved `resolvedApiKey` from
a configured `github-copilot` auth profile). When the resolved mode is
`useLoggedInUser`, the session-level field is omitted so the SDK keeps
deriving identity from the logged-in identity.

`ask_user` uses `SessionConfig.onUserInputRequest`. The bridge registers SDK
choices or option-less free-text prompts as gateway questions, accepts choice
indexes or labels for fixed-choice requests, and accepts free-form answers
when the SDK request allows them. Aborting the OpenClaw attempt cancels the
gateway record and returns an empty SDK answer.

## Related

- [Agent runtimes](/concepts/agent-runtimes)
- [Codex harness](/plugins/codex-harness)
- [Agent harness plugins (SDK reference)](/plugins/sdk-agent-harness)
