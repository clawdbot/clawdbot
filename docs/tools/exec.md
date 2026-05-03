---
summary: "Exec tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the exec tool
  - Debugging stdin or TTY behavior
title: "Exec tool"
---

Run shell commands in the workspace. Supports foreground + background execution via `process`.
If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`.
Background sessions are scoped per agent; `process` only sees sessions from the same agent.

## Parameters

<ParamField path="command" type="string" required>
Shell command to run.
</ParamField>

<ParamField path="workdir" type="string" default="cwd">
Working directory for the command.
</ParamField>

<ParamField path="env" type="object">
Key/value environment overrides merged on top of the inherited environment.
</ParamField>

<ParamField path="yieldMs" type="number" default="10000">
Auto-background the command after this delay (ms).
</ParamField>

<ParamField path="background" type="boolean" default="false">
Background the command immediately instead of waiting for `yieldMs`.
</ParamField>

<ParamField path="timeout" type="number" default="tools.exec.timeoutSec">
Override the configured exec timeout for this call. Set `timeout: 0` only when the command should run without the exec process timeout.
</ParamField>

<ParamField path="pty" type="boolean" default="false">
Run in a pseudo-terminal when available. Use for TTY-only CLIs, coding agents, and terminal UIs.
</ParamField>

<ParamField path="host" type="'auto' | 'sandbox' | 'gateway' | 'node'" default="auto">
Where to execute. `auto` resolves to `sandbox` when a sandbox runtime is active and `gateway` otherwise.
</ParamField>

<ParamField path="security" type="'deny' | 'allowlist' | 'full'">
Enforcement mode for `gateway` / `node` execution.
</ParamField>

<ParamField path="ask" type="'off' | 'on-miss' | 'always'">
Approval prompt behavior for `gateway` / `node` execution.
</ParamField>

<ParamField path="node" type="string">
Node id/name when `host=node`.
</ParamField>

<ParamField path="elevated" type="boolean" default="false">
Request elevated mode — escape the sandbox onto the configured host path. `security=full` is forced only when elevated resolves to `full`.
</ParamField>

Notes:

- `host` defaults to `auto`: sandbox when sandbox runtime is active for the session, otherwise gateway.
- `host` only accepts `auto`, `sandbox`, `gateway`, or `node`. It is not a hostname selector; hostname-like values are rejected before the command runs.
- `auto` is the default routing strategy, not a wildcard. Per-call `host=node` is allowed from `auto`; per-call `host=gateway` is only allowed when no sandbox runtime is active.
- With no extra config, `host=auto` still "just works": no sandbox means it resolves to `gateway`; a live sandbox means it stays in the sandbox.
- `elevated` escapes the sandbox onto the configured host path: `gateway` by default, or `node` when `tools.exec.host=node` (or the session default is `host=node`). It is only available when elevated access is enabled for the current session/provider.
- `gateway`/`node` approvals are controlled by `~/.openclaw/exec-approvals.json`.
- `node` requires a paired node (companion app or headless node host).
- If multiple nodes are available, set `exec.node` or `tools.exec.node` to select one.
- `exec host=node` is the only shell-execution path for nodes; the legacy `nodes.run` wrapper has been removed.
- `timeout` applies to foreground, background, `yieldMs`, gateway, sandbox, and node `system.run` execution. If omitted, OpenClaw uses `tools.exec.timeoutSec`; explicit `timeout: 0` disables the exec process timeout for that call.
- On non-Windows hosts, exec uses `SHELL` when set; if `SHELL` is `fish`, it prefers `bash` (or `sh`)
  from `PATH` to avoid fish-incompatible scripts, then falls back to `SHELL` if neither exists.
- On Windows hosts, exec prefers PowerShell 7 (`pwsh`) discovery (Program Files, ProgramW6432, then PATH),
  then falls back to Windows PowerShell 5.1.
- Host execution (`gateway`/`node`) rejects `env.PATH` and loader overrides (`LD_*`/`DYLD_*`) to
  prevent binary hijacking or injected code.
- OpenClaw sets `OPENCLAW_SHELL=exec` in the spawned command environment (including PTY and sandbox execution) so shell/profile rules can detect exec-tool context.
- `openclaw channels login` is blocked from `exec` because it is an interactive channel-auth flow; run it in a terminal on the gateway host, or use the channel-native login tool from chat when one exists.
- Important: sandboxing is **off by default**. If sandboxing is off, implicit `host=auto`
  resolves to `gateway`. Explicit `host=sandbox` still fails closed instead of silently
  running on the gateway host. Enable sandboxing or use `host=gateway` with approvals.
- Script preflight checks (for common Python/Node shell-syntax mistakes) only inspect files inside the
  effective `workdir` boundary. If a script path resolves outside `workdir`, preflight is skipped for
  that file.
- For long-running work that starts now, start it once and rely on automatic
  completion wake when it is enabled and the command emits output or fails.
  Use `process` for logs, status, input, or intervention; do not emulate
  scheduling with sleep loops, timeout loops, or repeated polling.
- For work that should happen later or on a schedule, use cron instead of
  `exec` sleep/delay patterns.

## Config

- `tools.exec.notifyOnExit` (default: true): when true, backgrounded exec sessions enqueue a system event and request a heartbeat on exit.
- `tools.exec.approvalRunningNoticeMs` (default: 10000): emit a single “running” notice when an approval-gated exec runs longer than this (0 disables).
- `tools.exec.timeoutSec` (default: 1800): default per-command exec timeout in seconds. Per-call `timeout` overrides it; per-call `timeout: 0` disables the exec process timeout.
- `tools.exec.host` (default: `auto`; resolves to `sandbox` when sandbox runtime is active, `gateway` otherwise)
- `tools.exec.security` (default: `deny` for sandbox, `full` for gateway + node when unset)
- `tools.exec.ask` (default: `off`)
- No-approval host exec is the default for gateway + node. If you want approvals/allowlist behavior, tighten both `tools.exec.*` and the host `~/.openclaw/exec-approvals.json`; see [Exec approvals](/tools/exec-approvals#yolo-mode-no-approval).
- YOLO comes from the host-policy defaults (`security=full`, `ask=off`), not from `host=auto`. If you want to force gateway or node routing, set `tools.exec.host` or use `/exec host=...`.
- In `security=full` plus `ask=off` mode, host exec follows the configured policy directly; there is no extra heuristic command-obfuscation prefilter or script-preflight rejection layer.
- `tools.exec.node` (default: unset)
- `tools.exec.strictInlineEval` (default: false): when true, inline interpreter eval forms such as `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `lua -e`, and `osascript -e` always require explicit approval. `allow-always` can still persist benign interpreter/script invocations, but inline-eval forms still prompt each time.
- `tools.exec.pathPrepend`: list of directories to prepend to `PATH` for exec runs (gateway + sandbox only).
- `tools.exec.safeBins`: stdin-only safe binaries that can run without explicit allowlist entries. For behavior details, see [Safe bins](/tools/exec-approvals-advanced#safe-bins-stdin-only).
- `tools.exec.safeBinTrustedDirs`: additional explicit directories trusted for `safeBins` path checks. `PATH` entries are never auto-trusted. Built-in defaults are `/bin` and `/usr/bin`.
- `tools.exec.safeBinProfiles`: optional custom argv policy per safe bin (`minPositional`, `maxPositional`, `allowedValueFlags`, `deniedFlags`).

Example:

```json5
{
  tools: {
    exec: {
      pathPrepend: ["~/bin", "/opt/oss/bin"],
    },
  },
}
```

### PATH handling

- `host=gateway`: merges your login-shell `PATH` into the exec environment. `env.PATH` overrides are
  rejected for host execution. The daemon itself still runs with a minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
- `host=sandbox`: runs `sh -lc` (login shell) inside the container, so `/etc/profile` may reset `PATH`.
  OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation);
  `tools.exec.pathPrepend` applies here too.
- `host=node`: only non-blocked env overrides you pass are sent to the node. `env.PATH` overrides are
  rejected for host execution and ignored by node hosts. If you need additional PATH entries on a node,
  configure the node host service environment (systemd/launchd) or install tools in standard locations.

Per-agent node binding (use the agent list index in config):

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Control UI: the Nodes tab includes a small “Exec node binding” panel for the same settings.

## Session overrides (`/exec`)

Use `/exec` to set **per-session** defaults for `host`, `security`, `ask`, and `node`.
Send `/exec` with no arguments to show the current values.

Example:

```
/exec host=auto security=allowlist ask=on-miss node=mac-1
```

## Authorization model

`/exec` is only honored for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`).
It updates **session state only** and does not write config. To hard-disable exec, deny it via tool
policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set
`security=full` and `ask=off`.

## Exec approvals (companion app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host.
See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

When approvals are required, the exec tool returns immediately with
`status: "approval-pending"` and an approval id. Once approved (or denied / timed out),
the Gateway emits system events (`Exec finished` / `Exec denied`). If the command is still
running after `tools.exec.approvalRunningNoticeMs`, a single `Exec running` notice is emitted.
On channels with native approval cards/buttons, the agent should rely on that
native UI first and only include a manual `/approve` command when the tool
result explicitly says chat approvals are unavailable or manual approval is the
only path.

## Allowlist + safe bins

Manual allowlist enforcement matches resolved binary path globs and bare command-name
globs. Bare names match only commands invoked through PATH, so `rg` can match
`/opt/homebrew/bin/rg` when the command is `rg`, but not `./rg` or `/tmp/rg`.
When `security=allowlist`, shell commands are auto-allowed only if every pipeline
segment is allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections
are rejected in allowlist mode unless every top-level segment satisfies the
allowlist (including safe bins). Redirections remain unsupported.
Durable `allow-always` trust does not bypass that rule: a chained command still requires every
top-level segment to match.

`autoAllowSkills` is a separate convenience path in exec approvals. It is not the same as
manual path allowlist entries. For strict explicit trust, keep `autoAllowSkills` disabled.

Use the two controls for different jobs:

- `tools.exec.safeBins`: small, stdin-only stream filters.
- `tools.exec.safeBinTrustedDirs`: explicit extra trusted directories for safe-bin executable paths.
- `tools.exec.safeBinProfiles`: explicit argv policy for custom safe bins.
- allowlist: explicit trust for executable paths.

Do not treat `safeBins` as a generic allowlist, and do not add interpreter/runtime binaries (for example `python3`, `node`, `ruby`, `bash`). If you need those, use explicit allowlist entries and keep approval prompts enabled.
`openclaw security audit` warns when interpreter/runtime `safeBins` entries are missing explicit profiles, and `openclaw doctor --fix` can scaffold missing custom `safeBinProfiles` entries.
`openclaw security audit` and `openclaw doctor` also warn when you explicitly add broad-behavior bins such as `jq` back into `safeBins`.
If you explicitly allowlist interpreters, enable `tools.exec.strictInlineEval` so inline code-eval forms still require a fresh approval.

For full policy details and examples, see [Exec approvals](/tools/exec-approvals-advanced#safe-bins-stdin-only) and [Safe bins versus allowlist](/tools/exec-approvals-advanced#safe-bins-versus-allowlist).

## Examples

Foreground:

```json
{ "tool": "exec", "command": "ls -la" }
```

Background + poll:

```json
{"tool":"exec","command":"npm run build","yieldMs":1000}
{"tool":"process","action":"poll","sessionId":"<id>"}
```

Polling is for on-demand status, not waiting loops. If automatic completion wake
is enabled, the command can wake the session when it emits output or fails.

Send keys (tmux-style):

```json
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Enter"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["C-c"]}
{"tool":"process","action":"send-keys","sessionId":"<id>","keys":["Up","Up","Enter"]}
```

Submit (send CR only):

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

Paste (bracketed by default):

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```

## apply_patch

`apply_patch` is a subtool of `exec` for structured multi-file edits.
It is enabled by default for OpenAI and OpenAI Codex models. Use config only
when you want to disable it or restrict it to specific models:

```json5
{
  tools: {
    exec: {
      applyPatch: { workspaceOnly: true, allowModels: ["gpt-5.5"] },
    },
  },
}
```

Notes:

- Only available for OpenAI/OpenAI Codex models.
- Tool policy still applies; `allow: ["write"]` implicitly allows `apply_patch`.
- Config lives under `tools.exec.applyPatch`.
- `tools.exec.applyPatch.enabled` defaults to `true`; set it to `false` to disable the tool for OpenAI models.
- `tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.

## Related

- [Exec Approvals](/tools/exec-approvals) — approval gates for shell commands
- [Sandboxing](/gateway/sandboxing) — running commands in sandboxed environments
- [Background Process](/gateway/background-process) — long-running exec and process tool
- [Security](/gateway/security) — tool policy and elevated access
