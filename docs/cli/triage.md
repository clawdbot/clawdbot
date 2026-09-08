---
summary: "CLI reference for `openclaw triage` (sanitized diagnostics and agent handoff)"
read_when:
  - OpenClaw is misbehaving and you want an agent-ready debugging prompt
  - An update failed and you want a local coding agent to repair it
  - You need a sanitized diagnostics bundle without starting an agent
title: "Triage"
---

# `openclaw triage`

Collect sanitized diagnostics and open a coding agent on this machine to diagnose, repair, and verify this OpenClaw installation.

```bash
openclaw triage
```

In an interactive terminal, triage starts the first directly launchable agent on `PATH` in this detection order: Claude Code (`claude`), Codex (`codex`), OpenCode (`opencode`), then Pi (`pi`). It prints the selected agent and passes a bounded repair prompt directly, without a picker. The agent uses its existing authentication, sandbox, and approval settings.

Choose a particular agent with `--agent`, or collect diagnostics without starting one with `--json` or `--non-interactive`:

```bash
openclaw triage --agent codex
openclaw triage --json
openclaw triage --non-interactive
```

The prompt includes the OpenClaw version, platform, Node.js version, prioritized Doctor findings with repair hints, and the diagnostics archive path. The archive contains sanitized config, best-effort Gateway status and health snapshots, operational log summaries, and available stability diagnostics. If the Gateway is unreachable, triage still writes the archive with available local diagnostics and records snapshot failures inside it. Doctor or export failures are recorded in the prompt so the agent can still investigate.

The diagnostics archive excludes secrets, tokens, raw chat payloads, and raw logs. Failed-update prompts include bounded, sanitized diagnostic excerpts, with secrets and local paths redacted before truncation. Paths inside the prompt are shown relative to `~` or `$OPENCLAW_STATE_DIR`; the saved prompt path, archive path, and printed handoff commands retain the real absolute paths needed by your shell. Diagnostic collection is read-only. A launched agent is asked to repair autonomously within its existing permissions and preserve configuration, history, and databases.

The archive's config summary counts agent, plugin, and channel entries declared in the saved file. Shared channel settings and `$include` directives are excluded from those counts; diagnostics do not expand included files.

## Failed update recovery

Before a failed update reaches triage, the updater may run
[bounded unattended repair](/install/updating#unattended-repair-on-your-own-inference)
for candidate validation failures or failed post-activation verification when
rollback is unsafe or fails. Those attempts use configured inference and appear
in the update run report. The updater owns any service restart and decides
success from validation; triage remains the handoff when recovery cannot finish.

Interactive update recovery uses this same handoff after the updater releases its maintenance state. It starts from the captured update failure and defers fresh Doctor checks and archive collection to the repair agent, so checks against the broken installation do not delay the handoff. The agent starts in the operator's captured working directory, or their OS home if that directory was removed or became inaccessible. Absolute installation selectors still identify the state, config, and default workspace to repair, even when the state directory cannot be accessed or created.

The prompt preserves the original error, before and after versions, and recorded recovery state ahead of current Doctor findings. It includes up to three failed or interrupted steps, excluding advisory Doctor results, with bounded excerpts from both stderr and stdout. It also retains bounded plugin failures and the terminal Doctor warning. The failure record is limited to 4 KiB and the whole prompt to 8 KiB. A healthy Doctor check does not erase the failed attempt, and an absent restart-safety verdict remains unknown.

Updates using `--yes`, JSON output, or a non-interactive session can start one owned automatic repair after an eligible mutation or restart failure, as described below. Other failures retain diagnostics and manual guidance. Initial argument, ownership, and installation refusals remain outside automatic repair. For a background or Control UI failure that cannot admit owned recovery, use the installation-specific command printed on the Gateway host, or run `openclaw triage` there. Standalone triage reads a pending failed-update notification without consuming it or creating a state database; delivery routes and continuation instructions are excluded.

Use `--update-result <path>` to include an updater's saved failure artifact. Triage reads at most 8 KiB of valid UTF-8 JSON and validates the failure record. Its printed embedded handoff command uses a sanitized support export, so it remains usable after a temporary updater input is deleted. Interactive handoffs with a captured failure defer fresh diagnostics; JSON and forced non-interactive runs still collect them.

The repair prompt directs the agent to preserve migrated state, investigate before rolling back or restarting, and verify the intended installation plus Gateway health and RPC connectivity after repair. A successful agent exit does not change the original updater failure into a successful update.

## Installation target and embedded handoff

Triage captures the diagnosed installation's resolved state directory, exact config path, and default workspace, including custom paths and named profiles. Local shell commands receive these as `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`, and `OPENCLAW_WORKSPACE_DIR`, so archive references and default workspace checks resolve against the diagnosed installation even when its selectors were implicit. An authored workspace in the installation's config still takes precedence over its default workspace. The embedded agent keeps its own config snapshot, sessions, execution cwd, and temporary run state separate; in-process config and session tools refer to that temporary run. Use local shell commands to inspect or repair the diagnosed installation.

`openclaw triage --run` requests up to one bounded embedded repair turn in an interactive terminal. Inference uses the system-agent owner's default model, then its configured `model.fallbacks`, then other configured agents' authenticated routes. Models that explicitly lack tool support and routes without usable authentication are skipped. If no route works, triage reports that embedded repair is unavailable; use a saved handoff command or repair model setup with `openclaw onboard`.

The loop runs Doctor lint before and after the turn, using the number of error findings to measure improvement. If the initial check reports no errors, it returns successfully without starting inference or a repair turn. Validation determines whether the installation is repaired; an agent's successful exit or claim that it fixed the problem is not enough. Triage allows one turn, ten minutes total, five minutes for the turn, and 40 tool calls. More error findings after a turn report the installation as unrepaired.

Post-turn Doctor checks run only after the executor confirms cleanup. If cleanup fails or times out, repair reports failure, retains execution state, and refuses another repair in that CLI process. Inspect the diagnostics and stop any remaining work before retrying from a new process.

Because the operator owns the update or explicit `--run` request, embedded repair replaces interactive exec approval with a prompt-free run scoped to the installation or staged candidate root (`fs.workspaceOnly: true`), preserves safe-bin and tool allowlists, and never overrides explicit exec or repair-tool denies. It refuses configured sandbox, node, and remote execution routes instead of redirecting them onto the host, and does not launch external coding-agent CLIs. An explicit deny reports `exec-denied-by-policy`; use `openclaw triage` for an external handoff. The saved execution policy is unchanged.

The repair prompt instructs the agent to change only the installation or staged candidate root and use the pinned OpenClaw state for diagnostics. It forbids editing credentials or auth stores, deleting state or databases, package-manager writes outside the target root, and starting, stopping, or restarting services or the Gateway. Filesystem tools enforce the workspace boundary; host commands follow the prompt's scope contract and are not an OS sandbox. Allowed checks include `openclaw doctor --lint --json`, `openclaw doctor --fix`, and `openclaw health --json`. The repair loop does not activate updates, restart services, take snapshots, or undo files.

Each turn is asked to end with a machine-readable line:

```text
REPAIR_RESULT: {"status":"fixed","summary":"Repaired the installation and checked Doctor lint."}
```

The status may be `fixed`, `partial`, or `not-fixed`. A missing or malformed line falls back to a bounded summary of the final text. Doctor validation remains authoritative. The failure context and repair instructions share the 8 KiB prompt limit.

On Windows, recognized npm `.cmd` and `.bat` shims launch their Node.js or native executable entrypoint directly, preserving the interactive terminal. Node.js entrypoints require the running Node.js runtime or `node.exe` on `PATH`. Custom wrappers that require a shell remain manual handoffs. An explicit `--agent` that is missing or manual-only exits non-zero without selecting a different agent.

## Manual handoff

Non-interactive sessions, JSON output, and installations without a directly launchable coding agent provide commands for an external diagnostic turn or the explicit embedded route. Saved external prompts are read from stdin, so quotes and multiline text do not depend on native command-line argument parsing. On macOS and Linux, the commands look like this:

```bash
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' claude -p < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' codex exec --skip-git-repo-check - < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' opencode run < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' pi --print < '<prompt-path>'
env OPENCLAW_STATE_DIR='<state-dir>' OPENCLAW_CONFIG_PATH='<config-path>' OPENCLAW_WORKSPACE_DIR='<default-workspace-dir>' openclaw triage --run
```

A captured update failure adds `--update-result <saved-failure-path>` to the embedded command. The external commands use their agent's normal non-interactive tool policy; triage does not bypass permission prompts. Use `openclaw triage --agent <name>` to start an interactive session.

Printed Windows commands target PowerShell, including Windows PowerShell 5.1. They read saved prompts as UTF-8, preserve literal paths, and restore your installation selectors after the command completes. WSL uses POSIX shell commands.

JSON output also includes `detectedAgents`, listing the external agents found on `PATH`. Standalone triage with JSON output, non-TTY sessions, or `--non-interactive` never starts an agent, even with `--agent`. The Codex command works outside a Git checkout; it does not change Codex sandbox or approval settings.

## Automatic failure handoff

Failed updates that reached installation changes, unhealthy update restarts, and recorded Gateway server startup failures can invoke the same triage flow automatically. Existing update settlement runs first; restoration requires the update owner to verify that restarting is safe. After package replacement, the installed CLI owns triage; unavailable or incompatible CLI files leave saved failure diagnostics and manual guidance. A supervised Gateway attempts triage only when its existing crash-loop breaker first trips. Later failures in the same Gateway process do not launch another agent.

The automatic handoff selects the configured embedded agent first, otherwise a directly launchable Claude Code or Codex CLI, in that order. External agents run non-interactively with their existing authentication and permissions. Claude Code uses `--safe-mode` to disable custom hooks, plugins, and project instructions while retaining authentication and built-in tools. Finding an executable does not establish authentication. A failed selected route, including a Claude version that does not support safe mode, is reported without trying another agent; the private prompt and manual handoff commands remain available.

Automatic embedded recovery retains the configured runtime because it must investigate the original failure, including symptoms that Doctor lint cannot detect. Its repair prompt can permit an owned atomic Gateway restart when running health verification is required; an intentionally stopped installation stays stopped. This differs from manual `triage --run`, whose Doctor-validated repair loop never owns service lifecycle changes.

Targeted automatic Codex repair requires an owned stdio app-server process. Unix-socket and WebSocket connections are refused: a socket server has an independent lifetime, and disconnecting does not stop its active turns; WebSocket URLs also cannot establish where native commands execute. Use the existing `plugins.entries.codex.config.appServer.transport` setting with `"stdio"`, or a saved external/manual handoff on this machine. Triage never silently switches a configured socket route to stdio. Ordinary Codex runs without an installation target retain socket and WebSocket support. ACP, provisioned sandboxes, remote/node execution and a Codex app-server with `remoteWorkspaceRoot` remain unsupported for automatic local-target repair; native sandbox and approval policy are preserved.

The fixing agent receives the original failure and a verification goal: check the intended installation with `openclaw health --json` and `openclaw status --all` or `openclaw gateway status --deep`, confirm the expected running version after an update when known, and verify the original symptom. A PID, valid config, or successful repair command alone does not prove recovery. The report must include changes, verification evidence, and any remaining blocker.

Skipped or blocked updates, capability approval refusals, ownership and schema refusals, startup failures with unconfirmed cleanup, existing-Gateway lock conflicts, external supervisors, and commands already running inside a fixing agent do not trigger another automatic agent. Automatic triage honors `--no-restart` and leaves intentionally stopped services stopped. Termination signals cancel foreground triage. Diagnostics and agent output go to stderr; the original failure result and exit status remain unchanged even if the agent reports success.

When upgrading from an older managed-update helper, a leftover transient claim is
reclaimed on the next admission only if its recorded process instance is positively
dead. This includes an exited updater runner or a verified reused PID, not just a
dead helper. Live, unverifiable, malformed, or concurrently replaced claims are left
alone. This cleanup does not adopt a live older helper into automatic triage:
incompatible live handoffs still require the saved diagnostics and manual guidance.

Automatic fixing is single-flight per canonical installation, including foreground updates and unsupervised Gateway startup. A competing failure reports that triage is already owned, preserves its original output and exit status, and leaves the running attempt alone. After confirmed cleanup, a later independent failure can start a fresh attempt.

Foreground triage stays attached to its caller. Cancellation or loss of that connection stops new work and gives registered OpenClaw resources their existing cleanup deadlines. The CLI gets the existing 30-second handoff grace to exit after cancellation or terminal disconnect; a stuck CLI is then terminated and its generation remains fenced. External coding CLIs manage native commands in separate process groups, so even a normal or cooperative CLI exit leaves foreground automatic cleanup uncertain. Their result and manual handoffs remain available. A failed embedded agent can still finish cleanup normally.

If the fixing process disappears abruptly, forced termination is needed, or teardown fails, automatic admission remains blocked for that OS boot. Registered embedded resources that confirm cleanup after cooperative cancellation allow another attempt; a forced or uncertain terminal outcome cannot certify that closure. Inspect the saved diagnostics and use `openclaw triage` manually. Do not delete the claim while prior work may still be running. A verified different OS boot allows a fresh attempt; triage never initiates a reboot. Unavailable boot identity or incompatible private handoff data leaves diagnostics and manual guidance.

Embedded OpenClaw repair keeps local non-PTY commands and stdio LSP/MCP servers under a process-group owner on macOS and Linux. Cleanup must confirm that the owned process group has disappeared; closed pipes, process listings, or a completed root command are insufficient. Commands that detach from that group and close inherited descriptors remain outside this cleanup guarantee. OpenClaw `exec` requests with `pty: true` fall back to a non-PTY child without starting a native PTY and report a warning; commands that require a terminal may fail. Windows stdio tools still lack cleanup confirmation, so their use leaves automatic cleanup uncertain.

For embedded Codex repair, cleanup must observe its owned descendants stopping before the app-server exits gracefully. An inspection failure, unconfirmed native terminal termination, a still-owned shared client, or a signalled app-server exit keeps automatic recovery blocked even when the transport has closed. Commands that deliberately detach from [Codex terminal ownership](/plugins/codex-harness) remain outside that cleanup guarantee.

For a Linux user-systemd Gateway, automatic managed recovery reuses the existing update handoff in a native scope attached to the Gateway service. **Cancellation begins when that native scope attachment is verified**, before readiness is announced or a fixing agent starts. Earlier update parking, restoration, and preparation keep their existing update behavior; a stop completed before attachment is not treated as cancellation of a future recovery. Failed update restoration may leave the installed service inactive, and triage can still be admitted. An unsafe installation or preserve-activation request permits offline diagnosis and repair while leaving the primary stopped; running health verification is deferred.

After a managed update, the updater stages its repair request and explicitly transfers it only after acknowledgement and a final cancellation check. A cancelled or disconnected request that was never transferred cannot start an agent. The native scope remains responsible for all process groups inside it; a failed or inactive scope is not considered closed while systemd still tracks its cgroup.

When managed triage needs a restart, use the atomic `openclaw gateway restart` command. An explicit stop cancels recovery and its descendants, including `systemctl --user stop <gateway-unit>` when the primary is already inactive or a restart is pending. Do not use stop-then-start during recovery. Losing the helper, fixing child, or current handoff claim also closes recovery; the updater cannot restore the Gateway afterward. Cancellation or infeasibility must be reported, and an agent exit code or prose alone is not proof of health.

Repair commands such as `openclaw doctor --fix` remain available when the target is offline and ownership, schema, and maintenance locks permit repair. If maintenance needs to stop the managed Gateway, it refuses from inside that Gateway's automatic fixing subtree before issuing the stop. Continue with read-only diagnosis or safe offline artifact repair followed by an atomic restart, or report the blocker so an independent operator can run maintenance from a shell outside triage.

Automatic managed execution is limited to verified Linux user-systemd ownership. Launchd, Windows, system-scope systemd, and unverifiable managed ownership retain diagnostics/manual guidance. Foreground recovery remains available. No broader native cancellation support is implied.

This connection requires a working CLI. Missing Node or CLI files, failures before Gateway server startup or while recording its boot, and invalid-config paths that retain the existing Doctor recovery flow may still require `openclaw triage` manually. It does not install a separate recovery service.

## Output and exit codes

The prompt is written to `logs/support/` inside the state directory with owner-only permissions, alongside the diagnostics archive and sanitized update failure when available. Prompt and archive paths are printed, and `--json` returns them plus finding counts by severity and handoff commands.

If a support artifact cannot be saved, triage reports the storage error and still passes the in-memory prompt to an available interactive agent, including an explicitly requested embedded turn. It does not report a saved prompt path for a failed write. Standalone JSON output, non-interactive sessions, and sessions without a launchable handoff retain a non-zero artifact failure; these explicit diagnostic runs never start an agent automatically.

A launched external agent inherits the current environment with the captured installation's state, config, and default workspace selectors pinned. The printed commands pin the same selectors and preserve shell quoting. External agents still control their own shell environment and execution policy; keep the handoff on this machine. Triage exits with the launched agent's exit code. If the agent cannot start, triage prints its manual command and exits non-zero; it does not try another provider. A failed embedded inference check, unsupported execution route, or `--run` without an interactive terminal also exits non-zero. Saved prompts and manual handoff commands remain available.

Embedded repair exits with 0 when Doctor validation passes, 2 when a time budget stops the run, and 1 for other incomplete or unavailable repairs. An improvement that leaves errors is still incomplete.

## Options

| Option                   | Effect                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `--json`                 | Emit prompt and archive paths, finding counts, detected agents, and commands.              |
| `--no-export`            | Skip the diagnostics archive; still prepare the prompt and use the selected handoff route. |
| `--agent <name>`         | Select `claude`, `codex`, `opencode`, or `pi` instead of automatic detection.              |
| `--run`                  | Run one bounded embedded repair turn with Doctor validation in an interactive terminal.    |
| `--non-interactive`      | Prepare diagnostics without prompting or starting an agent, including on a terminal.       |
| `--update-result <path>` | Include the bounded update-failure JSON diagnostics artifact written by the updater.       |

`--run` cannot be combined with `--json`, `--non-interactive`, or `--agent`.

Related: [Doctor](/cli/doctor), [Gateway](/cli/gateway), and [Troubleshooting](/help/troubleshooting).
