---
summary: "Run OpenClaw embedded agent turns through the external GitHub Copilot SDK harness"
title: "Copilot SDK harness"
read_when:
  - You want to use the GitHub Copilot SDK harness for an agent
  - You need configuration examples for the `copilot` runtime
  - You are wiring an agent to subscription Copilot (github / openclaw / copilot) and want it to run through the Copilot CLI
---

The external `@openclaw/copilot` plugin lets OpenClaw run embedded subscription
Copilot agent turns through the GitHub Copilot CLI (`@github/copilot-sdk`)
instead of the built-in PI harness.

Use the Copilot SDK harness when you want the Copilot CLI session to own the
low-level agent loop: native tool execution, native compaction
(`infiniteSessions`), and CLI-managed thread state under `copilotHome`.
OpenClaw still owns chat channels, session files, model selection, OpenClaw
dynamic tools (bridged), approvals, media delivery, the visible transcript
mirror, `/btw` side questions (handled by the in-tree PI fallback — see
[Side questions (`/btw`)](#side-questions-btw)), and `openclaw doctor`.

For the broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes).

## Requirements

- OpenClaw with the `@openclaw/copilot` plugin installed.
- If your config uses `plugins.allow`, include `copilot` (the manifest
  id declared by the plugin). A restrictive
  allowlist that uses the npm-style `@openclaw/copilot` package name
  will leave the plugin blocked and the runtime will not load
  even with `agentRuntime.id: "copilot"`.
- A GitHub Copilot subscription that can drive the Copilot CLI (or a
  `gitHubToken` env / auth-profile entry for headless / cron runs).
- A writable `copilotHome` directory. The harness defaults to
  `~/.openclaw/agents/<agentId>/copilot` for full per-agent isolation. The
  platform default (`%APPDATA%\copilot` on Windows, `$XDG_CONFIG_HOME/copilot`
  or `~/.config/copilot` elsewhere) is used as the doctor probe fallback when
  no explicit home is set.

`openclaw doctor` runs the plugin
[doctor contract](#doctor-and-probes) for the extension; failures there are
the canonical way to confirm the environment is ready before opting an agent
in.

## Plugin install

The Copilot runtime is an external plugin so the core `openclaw` package does
not carry the `@github/copilot-sdk` dependency or its platform-specific
`@github/copilot-<platform>-<arch>` CLI binary. Together they add roughly
260 MB, so install them only for agents that opt into this runtime:

```bash
openclaw plugins install @openclaw/copilot
```

The wizard installs the plugin the first time you select a
`github-copilot/*` model **and** your config opts the model (or its
provider) into the Copilot agent runtime via
`agentRuntime: { id: "copilot" }` (see [Quickstart](#quickstart) below).
Without the opt-in, openclaw uses its built-in GitHub Copilot provider
and never installs the runtime plugin.

The runtime resolves the SDK in this order:

1. `import("@github/copilot-sdk")` from the installed `@openclaw/copilot`
   package.
2. The well-known fallback dir `~/.openclaw/npm-runtime/copilot/` (the
   legacy on-demand install target).

A missing SDK surfaces a single error with code `COPILOT_SDK_MISSING`
and the plugin reinstall command above.

## Quickstart

Pin one model (or one provider) to the harness:

```json5
{
  agents: {
    defaults: {
      model: "github-copilot/gpt-5.5",
      models: {
        "github-copilot/gpt-5.5": {
          agentRuntime: { id: "copilot" },
        },
      },
    },
  },
}
```

Both routes are equivalent. Use `agentRuntime.id` on a single model entry
when only that model should be routed through the harness; set
`agentRuntime.id` on a provider when every model under that provider should
use it.

## Supported providers

The harness advertises support for the canonical `github-copilot` provider
(the same id owned by `extensions/github-copilot`):

- `github-copilot`

Anything outside that set falls through `selection.ts`'s `auto_pi` branch back
to PI.

## Auth

Per-agent precedence, applied during `runCopilotAttempt`:

1. **Explicit `useLoggedInUser: true`** on the attempt input. Uses the Copilot
   CLI's logged-in user resolved under the agent's `copilotHome`.
2. **Explicit `gitHubToken`** on the attempt input (with `profileId` +
   `profileVersion`). Useful for direct CLI invocations and tests where the
   caller wants to bypass auth-profile resolution.
3. **Contract-resolved `resolvedApiKey` + `authProfileId`** from the
   `EmbeddedRunAttemptParams` shape. This is the **production main path**:
   core resolves the agent's configured `github-copilot` auth profile
   (via `src/infra/provider-usage.auth.ts:resolveProviderAuths`) before
   invoking the harness, and the harness consumes both fields directly.
   This makes a `github-copilot:<profile>` auth profile work end-to-end
   for headless / cron / multi-profile setups without env vars.
4. **Env-var fallback** for direct CLI / dogfood runs where no auth
   profile is configured. The runtime checks the following vars in
   precedence order, mirroring the shipped `github-copilot` provider
   (`extensions/github-copilot/auth.ts`) and the documented Copilot SDK
   setup:
   1. `OPENCLAW_GITHUB_TOKEN` -- harness-specific override; set this
      to pin a token for the OpenClaw harness without disturbing
      system-wide `gh` / Copilot CLI config.
   2. `COPILOT_GITHUB_TOKEN` -- standard Copilot SDK / CLI env var.
   3. `GH_TOKEN` -- standard `gh` CLI env var (matches the existing
      `github-copilot` provider precedence).
   4. `GITHUB_TOKEN` -- generic GitHub token fallback.

   The first non-empty value wins; empty strings are treated as
   absent. The synthesised pool profile id is `env:<NAME>` and the
   profileVersion is a non-reversible sha256 fingerprint of the
   token, so rotating the env value cleanly busts the client pool.

5. **Default `useLoggedInUser`** when no token signal is available.

Each agent gets a dedicated `copilotHome` so Copilot CLI tokens, sessions, and
config do not leak between agents on the same machine. The default is
`<agentDir>/copilot` when the host hands the harness an agent directory
(isolating SDK state from OpenClaw's `models.json` / `auth-profiles.json` in
the same directory), or `~/.openclaw/agents/<agentId>/copilot` otherwise.
Override with `copilotHome: <path>` on the attempt input when you need a
custom location (for example, a shared mount for migration).

`probeCopilotAuthShape` (see [Doctor and probes](#doctor-and-probes)) is the
pure shape check that validates which of the modes above will be used.
It does not perform a live SDK handshake.

## Configuration surface

The harness reads its config from per-attempt input
(`runCopilotAttempt({...})`) plus a small set of env defaults inside
`extensions/copilot/src/`:

- `copilotHome` — per-agent CLI state directory (defaults documented above).
- `model` — string or `{ provider, id, api? }`. When omitted, OpenClaw uses
  the agent's normal model selection and the harness verifies the resolved
  provider is in the supported set.
- `reasoningEffort` — `"low" | "medium" | "high" | "xhigh"`. Maps from
  OpenClaw's `ThinkLevel` / `ReasoningLevel` resolution in
  `auto-reply/thinking.ts`.
- `infiniteSessionConfig` — optional override for the SDK
  `infiniteSessions` block driven by `harness.compact`. Defaults are safe to
  leave as-is.
- `hooksConfig` — optional bridge config exposing OpenClaw
  before/after-message-write hooks to the SDK loop.
- `permissionPolicy` — optional override for the SDK's
  `onPermissionRequest` handler used for built-in SDK tool kinds
  (`shell`, `write`, `read`, `url`, `mcp`, `memory`, `hook`). Defaults
  to `rejectAllPolicy` as a safety net; in practice the SDK never
  invokes any of those kinds because every bridged OpenClaw tool is
  registered with `overridesBuiltInTool: true` and
  `skipPermission: true` so 100% of tool calls flow through OpenClaw's
  wrapped `execute()`. See [Permissions and ask_user](#permissions-and-ask_user).
- `enableSessionTelemetry` — opt-in OpenTelemetry routing via
  `telemetry-bridge.ts`.

Nothing in the rest of OpenClaw needs to know about these fields. Other
plugins, channels, and core code only see the standard
`AgentHarnessAttemptParams` / `AgentHarnessAttemptResult` shape.

## Compaction

When `harness.compact` runs, the Copilot SDK harness:

1. Enables `infiniteSessions` on the SDK session.
2. Lets the SDK perform its native compaction.
3. Writes an OpenClaw-shaped marker at
   `workspacePath/files/openclaw-compaction-<ts>.json` so existing OpenClaw
   transcript readers still see a familiar artifact.

The OpenClaw side transcript mirror (see below) continues to receive the
post-compaction messages, so user-facing chat history stays consistent.

## Transcript mirroring

`runCopilotAttempt` dual-writes each turn's mirrorable messages into the
OpenClaw audit transcript via
`extensions/copilot/src/dual-write-transcripts.ts`. The mirror is
per-session scoped (`copilot:${sessionId}`) and uses a per-message
identity (`${role}:${sha256_16(role,content)}`) so re-emits of prior-turn
entries collide with existing on-disk keys and do not duplicate.

The mirror is wrapped in two layers of failure containment so a transcript
write failure cannot fail the attempt: an internal best-effort wrapper and a
defense-in-depth `.catch(...)` at the attempt level. Failures are logged but
not surfaced.

## Side questions (`/btw`)

`/btw` is **not** native on this harness. `createCopilotAgentHarness()`
deliberately leaves `harness.runSideQuestion` undefined, so OpenClaw's `/btw`
dispatcher (`src/agents/btw.ts`) falls through to the same in-tree PI fallback
path it uses for every non-Codex runtime: the configured model provider is
called directly with a short side-question prompt and streamed back via
`streamSimple` (no CLI session, no extra pool slot).

This keeps Copilot CLI sessions reserved for the agent's main turn loop, and
keeps `/btw` behavior identical to other PI-backed runtimes. The contract is
asserted in
[`extensions/copilot/harness.test.ts`](https://github.com/openclaw/openclaw/blob/main/extensions/copilot/harness.test.ts)
under `describe("runSideQuestion")`.

## Doctor and probes

`extensions/copilot/doctor-contract-api.ts` is auto-loaded by
`src/plugins/doctor-contract-registry.ts`. It contributes:

- An empty `legacyConfigRules` (no retired fields at MVP).
- A no-op `normalizeCompatibilityConfig` (kept so future field retirements
  have a stable in-tree home).
- One `sessionRouteStateOwners` entry claiming provider `github-copilot`;
  runtime `copilot`; CLI session key `copilot`; auth profile
  prefix `github-copilot:`.

`extensions/copilot/src/doctor-probes.ts` exports three imperative probes
that hosts (including `openclaw doctor`) can call to verify the environment:

| Probe                      | What it checks                                                                    | Reasons it can fail                                                              |
| -------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `probeCopilotCliVersion`   | `copilot --version` exits 0 with a non-empty version string                       | `non-zero-exit`, `empty-version`, `spawn-failed`, `spawn-error`, `probe-timeout` |
| `probeCopilotHomeWritable` | `mkdir -p copilotHome` + write + rm a marker file                                 | `copilothome-not-writable` (with the underlying fs error in `details.rawError`)  |
| `probeCopilotAuthShape`    | At least one of `useLoggedInUser`, `gitHubToken`, or `profileId`+`profileVersion` | `no-auth-source`                                                                 |

Each probe accepts a DI seam (`spawnFn`, `fsApi`) so tests do not spawn the
real Copilot CLI or touch the host fs.

## Limitations

- The harness only claims the canonical `github-copilot` provider at MVP.
  Additional providers (BYOK or otherwise) should land in follow-up PRs that
  ship the adapter alongside the wire-up.
- The harness does not deliver TUI; PI's TUI is unaffected and remains the
  fallback for whatever runtimes do not have a peer surface.
- PI session state is not migrated when an agent switches to `copilot`.
  Selection is per attempt; existing PI sessions remain valid.
- **Interactive `ask_user` is not yet wired.** The SDK's
  `onUserInputRequest` handler is intentionally not registered, which
  per the SDK contract hides the `ask_user` tool from the model
  entirely. Agents running under this harness make best-judgment
  decisions from the initial prompt rather than asking clarifying
  questions mid-turn. A follow-up will port the codex pattern at
  `extensions/codex/src/app-server/user-input-bridge.ts` to route SDK
  `UserInputRequest`s through the OpenClaw channel/TUI prompt path; the
  dormant scaffolding in `extensions/copilot/src/user-input-bridge.ts`
  is the surface that follow-up will wire.

## Permissions and ask_user

Permission enforcement for bridged OpenClaw tools happens **inside the
tool wrapper**, not via the SDK's `onPermissionRequest` callback. The
same `wrapToolWithBeforeToolCallHook` that PI uses
(`src/agents/pi-tools.before-tool-call.ts`) is applied by
`createOpenClawCodingTools` to every coding tool: loop detection,
trusted plugin policies, before-tool-call hooks, and two-phase plugin
approvals via the gateway (`plugin.approval.request`) all run with the
exact same code path as native PI attempts.

To let that wrapper own the decision, the SDK Tool returned by
`convertOpenClawToolToSdkTool` is marked with:

- `overridesBuiltInTool: true` — replaces the Copilot CLI's built-in
  tool of the same name (edit, read, write, bash, …) so every tool
  invocation routes back to OpenClaw.
- `skipPermission: true` — tells the SDK not to fire
  `onPermissionRequest({kind: "custom-tool"})` before invoking the tool.
  The wrapped `execute()` performs the richer OpenClaw policy check
  internally; an SDK-level prompt would either short-circuit OpenClaw's
  enforcement (if we allow-all) or block every tool call (if we
  reject-all) — neither matches PI parity.

The in-tree codex harness uses the same split: bridged OpenClaw tools
are wrapped (`extensions/codex/src/app-server/dynamic-tools.ts`) and
the codex-app-server's _own_ native approval kinds
(`item/commandExecution/requestApproval`,
`item/fileChange/requestApproval`,
`item/permissions/requestApproval`) are routed through
`plugin.approval.request`
(`extensions/codex/src/app-server/approval-bridge.ts`). The Copilot SDK
equivalent — fail-closed `rejectAllPolicy` for any non-`custom-tool`
kind that ever reaches `onPermissionRequest` — is the same safety net,
and it does not fire in practice because `overridesBuiltInTool: true`
displaces every built-in.

For the wrapped-tool layer to make policy decisions equivalent to PI,
the harness forwards the full PI attempt-tool context to
`createOpenClawCodingTools` — identity (`senderIsOwner`,
`memberRoleIds`, `ownerOnlyToolAllowlist`, …), channel/routing
(`groupId`, `currentChannelId`, `replyToMode`, message-tool toggles),
auth (`authProfileStore`), run identity
(`sessionKey`/`runSessionKey` derived from `sandboxSessionKey`,
`runId`), model context (`modelApi`, `modelContextWindowTokens`,
`modelCompat`, `modelHasVision`), and run hooks (`onToolOutcome`,
`onYield`). Without those fields, owner-only allowlists silently
behave as deny-by-default, plugin-trust policies cannot resolve to the
right scope, and `session_status: "current"` resolves to a stale
sandbox key. The bridge builder is in
`extensions/copilot/src/tool-bridge.ts` and mirrors the PI
authoritative call at
`src/agents/pi-embedded-runner/run/attempt.ts:1029-1117`. Two PI fields
are intentionally **not** forwarded at MVP and tracked as follow-ups:
`sandbox` (the harness does not yet route through `resolveSandboxContext`)
and the PI tool-search/code-mode machinery
(`toolSearchCatalogRef`, `includeCoreTools`,
`includeToolSearchControls`, `toolSearchCatalogExecutor`,
`toolConstructionPlan`), which has no analog at the SDK boundary.

### Session-level GitHub token

The Copilot SDK contract distinguishes the **client-level** GitHub
token (`CopilotClientOptions.gitHubToken`, used to authenticate the
CLI process itself) from the **session-level** token
(`SessionConfig.gitHubToken`, which determines content exclusion,
model routing, and quota for that session and is honored on both
`createSession` and `resumeSession`). The harness resolves auth once
via `resolveCopilotAuth` and sets both fields when the auth mode is
`gitHubToken` (an explicit `auth.gitHubToken` or a contract-resolved
`resolvedApiKey` from a configured `github-copilot` auth profile).
When the resolved mode is `useLoggedInUser`, the session-level field
is omitted so the SDK keeps deriving identity from the logged-in
identity.

`ask_user` is intentionally hidden — see Limitations above.

## Related

- [Agent runtimes](/concepts/agent-runtimes)
- [Codex harness](/plugins/codex-harness)
- [Agent harness plugins (SDK reference)](/plugins/sdk-agent-harness)
