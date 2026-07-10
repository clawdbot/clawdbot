---
summary: "Exec tool usage, stdin modes, and TTY support"
read_when:
  - Using or modifying the exec tool
  - Debugging stdin or TTY behavior
title: "Exec tool"
---

Run shell commands in the workspace. `exec` is a mutating shell surface: commands can create, edit, or delete files wherever the selected host or sandbox filesystem permits. Disabling OpenClaw filesystem tools such as `write`, `edit`, or `apply_patch` does not make `exec` read-only.

Supports foreground and background execution via `process`. If `process` is disallowed, `exec` runs synchronously and ignores `yieldMs`/`background`. Background sessions are scoped per agent; `process` only sees sessions from the same agent.

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
Override the configured exec timeout for this call, in seconds. Applies to foreground, background, `yieldMs`, gateway, sandbox, and node `system.run` execution. `timeout: 0` disables the exec process timeout for that call.
</ParamField>

<ParamField path="pty" type="boolean" default="false">
Run in a pseudo-terminal when available. Use for TTY-only CLIs, coding agents, and terminal UIs.
</ParamField>

<ParamField path="host" type="'auto' | 'sandbox' | 'gateway' | 'node'" default="auto">
Where to execute. `auto` resolves to `sandbox` when a sandbox runtime is active and `gateway` otherwise.
</ParamField>

<ParamField path="security" type="'deny' | 'allowlist' | 'full'">
Ignored for normal tool calls. `gateway`/`node` security is controlled by `tools.exec.security` and the host approvals file; elevated mode can force `security=full` only when the operator explicitly grants elevated access.
</ParamField>

<ParamField path="ask" type="'off' | 'on-miss' | 'always'">
The baseline ask mode comes from `tools.exec.ask` and host approvals. For channel-origin model calls, per-call `ask` is ignored when the effective host ask is `off`; otherwise it can only harden to a stricter mode. Trusted internal/API callers that construct exec tools with an explicit `ask` value are unchanged.
</ParamField>

<ParamField path="node" type="string">
Node id/name when `host=node`.
</ParamField>

<ParamField path="elevated" type="boolean" default="false">
Request elevated mode: escape the sandbox onto the configured host path. `security=full` is forced only when elevated resolves to `full`.
</ParamField>

Notes:

- `host` only accepts `auto`, `sandbox`, `gateway`, or `node`. It is not a hostname selector; hostname-like values are rejected before the command runs.
- Per-call `host=node` is allowed from `auto`; per-call `host=gateway` is only allowed when no sandbox runtime is active.
- With no extra config, `host=auto` still "just works": no sandbox means it resolves to `gateway`; a live sandbox means it stays in the sandbox.
- `elevated` escapes the sandbox onto the configured host path: `gateway` by default, or `node` when `tools.exec.host=node` (or the session default is `host=node`). It is only available when elevated access is enabled for the current session/provider.
- `gateway`/`node` approvals are controlled by the host approvals file.
- `node` requires a paired node (companion app or headless node host). If multiple nodes are available, set `exec.node` or `tools.exec.node` to select one.
- `exec host=node` is the only shell-execution path for nodes; the legacy `nodes.run` wrapper has been removed.
- On non-Windows hosts, exec uses `SHELL` when set; if `SHELL` is `fish`, it prefers `bash` (or `sh`) from `PATH` to avoid fish-incompatible bashisms, then falls back to `SHELL` if neither exists.
- On Windows hosts, exec prefers PowerShell 7 (`pwsh`) discovery (Program Files, ProgramW6432, then PATH), then falls back to Windows PowerShell 5.1.
- On non-Windows gateway hosts, bash and zsh exec commands use a startup snapshot. OpenClaw captures sourceable aliases/functions and a small safe environment set from shell startup files into `$OPENCLAW_STATE_DIR/cache/shell-snapshots/`, then sources that snapshot before each exec command. Secret-looking variables are excluded; sandbox and node exec do not use this snapshot. Set `OPENCLAW_EXEC_SHELL_SNAPSHOT=0` in the Gateway process environment to disable this snapshot path.
- Host execution (`gateway`/`node`) rejects `env.PATH` and loader overrides (`LD_*`/`DYLD_*`) to prevent binary hijacking or injected code.
- OpenClaw sets `OPENCLAW_SHELL=exec` in the spawned command environment (including PTY and sandbox execution) so shell/profile rules can detect exec-tool context.
- For channel-origin runs, OpenClaw also exposes a narrow sender/chat identity JSON payload in `OPENCLAW_CHANNEL_CONTEXT` when the channel provided those ids.
- `exec` cannot run `openclaw channels login` or `/approve` shell commands: `openclaw channels login` is an interactive channel-auth flow, and `/approve` needs to go through the approval command handler, not a shell. Run channel login in a terminal on the gateway host, or use a channel-specific login agent tool when one exists (for example `whatsapp_login`).
- Important: sandboxing is **off by default**. If sandboxing is off, implicit `host=auto` resolves to `gateway`. Explicit `host=sandbox` still fails closed instead of silently running on the gateway host. Enable sandboxing or use `host=gateway` with approvals.
- Script preflight checks (for common Python/Node shell-syntax mistakes) only inspect files inside the effective `workdir` boundary. If a script path resolves outside `workdir`, preflight is skipped for that file. Preflight also skips entirely when `host=gateway` and the effective policy is `security=full` with `ask=off`.
- For long-running work that starts now, start it once and rely on automatic completion wake when it is enabled and the command emits output or fails. Use `process` for logs, status, input, or intervention; do not emulate scheduling with sleep loops, timeout loops, or repeated polling.
- For work that should happen later or on a schedule, use cron instead of `exec` sleep/delay patterns.

## Config

| Key                                  | Default                                                | Notes                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools.exec.timeoutSec`              | `1800`                                                 | Default per-command exec timeout in seconds. Per-call `timeout` overrides it; per-call `timeout: 0` disables the exec process timeout.                  |
| `tools.exec.host`                    | `auto`                                                 | Resolves to `sandbox` when a sandbox runtime is active, `gateway` otherwise.                                                                            |
| `tools.exec.security`                | `deny` for sandbox, `full` for gateway/node when unset |                                                                                                                                                         |
| `tools.exec.ask`                     | `off`                                                  |                                                                                                                                                         |
| `tools.exec.mode`                    | unset                                                  | Normalized policy knob. See [Modes](#modes) below. Cannot be combined with `tools.exec.security`/`tools.exec.ask`.                                      |
| `tools.exec.reviewer.model`          | configured agent primary                               | Optional provider/model override for `mode=auto` review.                                                                                                |
| `tools.exec.reviewer.timeoutMs`      | `30000`                                                | Per-stage timeout for reviewer model preparation and completion before human fallback.                                                                  |
| `tools.exec.node`                    | unset                                                  |                                                                                                                                                         |
| `tools.exec.notifyOnExit`            | `true`                                                 | When true, backgrounded exec sessions enqueue a system event and request a heartbeat on exit.                                                           |
| `tools.exec.approvalRunningNoticeMs` | `10000`                                                | Emit a single "running" notice when an approval-gated exec runs longer than this (`0` disables).                                                        |
| `tools.exec.strictInlineEval`        | `false`                                                | See [Inline eval](#inline-eval-strictinlineeval).                                                                                                       |
| `tools.exec.commandHighlighting`     | `false`                                                | When true, approval prompts can highlight parser-derived command spans in the command text. Set globally or per agent; does not change approval policy. |
| `tools.exec.pathPrepend`             | unset                                                  | List of directories to prepend to `PATH` for exec runs (gateway + sandbox only).                                                                        |
| `tools.exec.safeBins`                | unset                                                  | Stdin-only safe binaries that can run without explicit allowlist entries. See [Safe bins](/tools/exec-approvals-advanced#safe-bins-stdin-only).         |
| `tools.exec.safeBinTrustedDirs`      | `/bin`, `/usr/bin`                                     | Additional explicit directories trusted for `safeBins` path checks. `PATH` entries are never auto-trusted.                                              |
| `tools.exec.safeBinProfiles`         | unset                                                  | Optional custom argv policy per safe bin (`minPositional`, `maxPositional`, `allowedValueFlags`, `deniedFlags`).                                        |

No-approval host exec is the default for gateway and node (`security=full`, `ask=off`) — this comes from the host-policy defaults, not from `host=auto`. If you want approvals/allowlist behavior, tighten both `tools.exec.*` and the host approvals file; see [Exec approvals](/tools/exec-approvals#yolo-mode-no-approval). To force gateway or node routing regardless of sandbox state, set `tools.exec.host` or use `/exec host=...`.

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

### Modes

`tools.exec.mode` is the normalized policy knob. Setting it derives `security`/`ask` and cannot be combined with explicit `tools.exec.security`/`tools.exec.ask`.

| Mode        | security    | ask       | Behavior                                                                                                                       |
| ----------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `deny`      | `deny`      | `off`     | Exec is denied.                                                                                                                |
| `allowlist` | `allowlist` | `off`     | Only allowlisted/safe-bin commands run; nothing else is asked.                                                                 |
| `ask`       | `allowlist` | `on-miss` | Allowlist matches run directly; everything else asks a human.                                                                  |
| `auto`      | `allowlist` | `on-miss` | Allowlist/safe-bin matches run directly; everything else routes through OpenClaw's native auto reviewer before asking a human. |
| `full`      | `full`      | `off`     | No approval gate.                                                                                                              |

`ask`/`ask=always` still asks a human every time regardless of mode.

Auto-review approval is single-use. On the gateway, OpenClaw supplies the resolved executable path to the reviewer and pins execution to that same path. Commands that cannot be reduced to one enforceable execution plan—such as heredocs, shell expansions, or unsupported wrapper quoting—fall back to human approval even if the model would otherwise allow them.

Codex app-server command approvals that are not already decided by explicit runtime or native policy use the human approval route. OpenClaw does not run its configured exec reviewer for these requests because Codex does not expose an enforceable resolved executable that can bind the review decision to the command Codex runs.

### Inline eval (`strictInlineEval`)

When `tools.exec.strictInlineEval` is `true`, inline interpreter-eval forms require reviewer or explicit approval: `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `lua -e`, `osascript -e`, and similar forms across other supported interpreters and command carriers (`awk`, `find -exec`, `make`, `sed`, `xargs`, and more). In `mode=auto`, the normal exec approval path may let the native auto reviewer allow a clearly low-risk one-off command; direct node-host `system.run` calls still require an explicit approval because they cannot hand the command to a human approval route. If the reviewer asks, the request goes to a human. `allow-always` can still persist benign interpreter/script invocations, but inline-eval forms do not become durable allow rules.

### PATH handling

- `host=gateway`: merges your login-shell `PATH` into the exec environment. `env.PATH` overrides are rejected for host execution. The daemon itself still runs with a minimal `PATH`:
  - macOS: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`
  - Linux: `/usr/local/bin`, `/usr/bin`, `/bin`
  - To prevent user shell configuration (like `~/.zshenv` or `/etc/zshenv`) from overriding priority paths during startup, `tools.exec.pathPrepend` entries are securely prepended to the final `PATH` inside the shell command right before execution.
- `host=sandbox`: runs `sh -lc` (login shell) inside the container, so `/etc/profile` may reset `PATH`. OpenClaw prepends `env.PATH` after profile sourcing via an internal env var (no shell interpolation); `tools.exec.pathPrepend` applies here too.
- `host=node`: only non-blocked env overrides you pass are sent to the node. `env.PATH` overrides are rejected for host execution and ignored by node hosts. If you need additional PATH entries on a node, configure the node host service environment (systemd/launchd) or install tools in standard locations.

Per-agent node binding (use the agent list index in config):

```bash
openclaw config get agents.list
openclaw config set 'agents.list[0].tools.exec.node' "node-id-or-name"
```

Control UI: the Nodes tab includes a small "Exec node binding" panel for the same settings.

## Session overrides (`/exec`)

Use `/exec` to set **per-session** defaults for `host`, `security`, `ask`, and `node`. Send `/exec` with no arguments to show the current values.

Example:

```text
/exec host=auto security=allowlist ask=on-miss node=mac-1
```

`/exec` is only honored for **authorized senders** (channel allowlists/pairing plus `commands.useAccessGroups`). It updates **session state only** and does not write config. Authorized external channel senders may set these session defaults. Internal gateway/webchat clients need `operator.admin` to persist them.

To hard-disable exec, deny it via tool policy (`tools.deny: ["exec"]` or per-agent). Host approvals still apply unless you explicitly set `security=full` and `ask=off`.

## Exec approvals (companion app / node host)

Sandboxed agents can require per-request approval before `exec` runs on the gateway or node host. See [Exec approvals](/tools/exec-approvals) for the policy, allowlist, and UI flow.

When a human approval is required, node-host and non-native gateway flows return immediately with `status: "approval-pending"` and an approval id. Native chat and Web UI gateway flows can instead wait inline and return the final command result after approval. An `approval-pending` result means the command has not started, so foreground fallback warnings appear only if the approved command actually runs inline. Approved asynchronous runs emit command progress and completion system events (`Exec running` / `Exec finished`); denied or timed-out approvals are terminal and do not wake the agent session with a denial system event.

On channels with native approval cards/buttons, the agent should rely on that native UI first and only include a manual `/approve` command when the tool result explicitly says chat approvals are unavailable or manual approval is the only path.

## Allowlist + safe bins

Manual allowlist enforcement matches resolved binary path globs and bare command-name globs. Bare names match only commands invoked through PATH, so `rg` can match `/opt/homebrew/bin/rg` when the command is `rg`, but not `./rg` or `/tmp/rg`.

When `security=allowlist`, shell commands are auto-allowed only if every pipeline segment is allowlisted or a safe bin. Chaining (`;`, `&&`, `||`) and redirections are rejected in allowlist mode unless every top-level segment satisfies the allowlist (including safe bins). Redirections remain unsupported. Durable `allow-always` trust does not bypass that rule: a chained command still requires every top-level segment to match.

`autoAllowSkills` is a separate convenience path in exec approvals, not the same as manual path allowlist entries. For strict explicit trust, keep `autoAllowSkills` disabled.

Use the two controls for different jobs:

- `tools.exec.safeBins`: small, stdin-only stream filters.
- `tools.exec.safeBinTrustedDirs`: explicit extra trusted directories for safe-bin executable paths.
- `tools.exec.safeBinProfiles`: explicit argv policy for custom safe bins.
- allowlist: explicit trust for executable paths.

Do not treat `safeBins` as a generic allowlist, and do not add interpreter/runtime binaries (for example `python3`, `node`, `ruby`, `bash`). If you need those, use explicit allowlist entries and keep approval prompts enabled.

`openclaw security audit` warns when interpreter/runtime `safeBins` entries are missing explicit profiles, and `openclaw doctor --fix` can scaffold missing custom `safeBinProfiles` entries. `openclaw security audit` and `openclaw doctor` also warn when you explicitly add broad-behavior bins such as `jq` back into `safeBins` (`jq` can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead). `jq` is denied as a safe bin even when it is explicitly listed. If you explicitly allowlist interpreters, enable `tools.exec.strictInlineEval` so inline code-eval forms still require reviewer or explicit approval.

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

Polling is for on-demand status, not waiting loops. If automatic completion wake is enabled, the command can wake the session when it emits output or fails.

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

`apply_patch` is a subtool of `exec` for structured multi-file edits. It is enabled by default and available to any model provider; `allowModels` can restrict it. Use config only when you want to disable it or restrict it to specific models:

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

- Tool policy still applies; `allow: ["write"]` implicitly allows `apply_patch`.
- `deny: ["write"]` does not deny `apply_patch`; deny `apply_patch` explicitly or use `deny: ["group:fs"]` when patch writes should also be blocked.
- Config lives under `tools.exec.applyPatch`.
- `tools.exec.applyPatch.enabled` defaults to `true`; set it to `false` to disable the tool.
- `tools.exec.applyPatch.workspaceOnly` defaults to `true` (workspace-contained). Set it to `false` only if you intentionally want `apply_patch` to write/delete outside the workspace directory.
- `tools.exec.applyPatch.allowModels` is an optional allowlist of model ids (raw, like `gpt-5.4`, or full, like `openai/gpt-5.4`). When set, only matching models get the tool; when unset, all models get it.

## Related

- [Exec Approvals](/tools/exec-approvals) — approval gates for shell commands
- [Sandboxing](/gateway/sandboxing) — running commands in sandboxed environments
- [Background Process](/gateway/background-process) — long-running exec and process tool
- [Security](/gateway/security) — tool policy and elevated access
