---
summary: "Advanced exec approvals: safe bins, interpreter binding, approval forwarding, native delivery"
read_when:
  - Configuring safe bins or custom safe-bin profiles
  - Forwarding approvals to Slack/Discord/Telegram or other chat channels
  - Implementing a native approval client for a channel
title: "Exec approvals — advanced"
---

Advanced exec-approval topics: the `safeBins` fast-path, interpreter/runtime
binding, and approval-forwarding to chat channels (including native delivery).
For the core policy and approval flow, see [Exec approvals](/tools/exec-approvals).

## Safe bins (stdin-only)

`tools.exec.safeBins` defines a small list of **stdin-only** binaries (for
example `cut`) that can run in allowlist mode **without** explicit allowlist
entries. Safe bins reject positional file args and path-like tokens, so they
can only operate on the incoming stream. Treat this as a narrow fast-path for
stream filters, not a general trust list.

<Warning>
Do **not** add interpreter or runtime binaries (for example `python3`, `node`,
`ruby`, `bash`, `sh`, `zsh`) to `safeBins`. If a command can evaluate code,
execute subcommands, or read files by design, prefer explicit allowlist entries
and keep approval prompts enabled. Custom safe bins must define an explicit
profile in `tools.exec.safeBinProfiles.<bin>`.
</Warning>

Default safe bins:

[//]: # "SAFE_BIN_DEFAULTS:START"

`cut`, `uniq`, `head`, `tail`, `tr`, `wc`

[//]: # "SAFE_BIN_DEFAULTS:END"

`grep` and `sort` are not in the default list. If you opt in, keep explicit
allowlist entries for their non-stdin workflows. For `grep` in safe-bin mode,
provide the pattern with `-e`/`--regexp`; positional pattern form is rejected
so file operands cannot be smuggled as ambiguous positionals.

### Argv validation and denied flags

Validation is deterministic from argv shape only (no host filesystem existence
checks), which prevents file-existence oracle behavior from allow/deny
differences. File-oriented options are denied for default safe bins; long
options are validated fail-closed (unknown flags and ambiguous abbreviations are
rejected).

Denied flags by safe-bin profile:

[//]: # "SAFE_BIN_DENIED_FLAGS:START"

- `grep`: `--dereference-recursive`, `--directories`, `--exclude-from`, `--file`, `--recursive`, `-R`, `-d`, `-f`, `-r`
- `jq`: `--argfile`, `--from-file`, `--library-path`, `--rawfile`, `--slurpfile`, `-L`, `-f`
- `sort`: `--compress-program`, `--files0-from`, `--output`, `--random-source`, `--temporary-directory`, `-T`, `-o`
- `wc`: `--files0-from`

[//]: # "SAFE_BIN_DENIED_FLAGS:END"

Safe bins also force argv tokens to be treated as **literal text** at execution
time (no globbing and no `$VARS` expansion) for stdin-only segments, so patterns
like `*` or `$HOME/...` cannot be used to smuggle file reads.

### Trusted binary directories

Safe bins must resolve from trusted binary directories (system defaults plus
optional `tools.exec.safeBinTrustedDirs`). `PATH` entries are never auto-trusted.
Default trusted directories are intentionally minimal: `/bin`, `/usr/bin`. If
your safe-bin executable lives in package-manager/user paths (for example
`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin`, `/snap/bin`), add them
explicitly to `tools.exec.safeBinTrustedDirs`.

### Shell chaining, wrappers, and multiplexers

Shell chaining (`&&`, `||`, `;`) is allowed when every top-level segment
satisfies the allowlist (including safe bins or skill auto-allow). Redirections
remain unsupported in allowlist mode. Command substitution (`$()` / backticks) is
rejected during allowlist parsing, including inside double quotes; use single
quotes if you need literal `$()` text.

On macOS companion-app approvals, raw shell text containing shell control or
expansion syntax (`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`) is
treated as an allowlist miss unless the shell binary itself is allowlisted.

For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped env overrides are
reduced to a small explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`,
`NO_COLOR`, `FORCE_COLOR`).

For `allow-always` decisions in allowlist mode, known dispatch wrappers (`env`,
`nice`, `nohup`, `stdbuf`, `timeout`) persist the inner executable path instead
of the wrapper path. Shell multiplexers (`busybox`, `toybox`) are unwrapped for
shell applets (`sh`, `ash`, etc.) the same way. If a wrapper or multiplexer
cannot be safely unwrapped, no allowlist entry is persisted automatically.

If you allowlist interpreters like `python3` or `node`, prefer
`tools.exec.strictInlineEval=true` so inline eval still requires an explicit
approval. In strict mode, `allow-always` can still persist benign
interpreter/script invocations, but inline-eval carriers are not persisted
automatically.

### Safe bins versus allowlist

| Topic            | `tools.exec.safeBins`                                  | Allowlist (`exec-approvals.json`)                                                  |
| ---------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Goal             | Auto-allow narrow stdin filters                        | Explicitly trust specific executables                                              |
| Match type       | Executable name + safe-bin argv policy                 | Resolved executable path glob, or bare command-name glob for PATH-invoked commands |
| Argument scope   | Restricted by safe-bin profile and literal-token rules | Path match only; arguments are otherwise your responsibility                       |
| Typical examples | `head`, `tail`, `tr`, `wc`                             | `jq`, `python3`, `node`, `ffmpeg`, custom CLIs                                     |
| Best use         | Low-risk text transforms in pipelines                  | Any tool with broader behavior or side effects                                     |

Configuration location:

- `safeBins` comes from config (`tools.exec.safeBins` or per-agent `agents.list[].tools.exec.safeBins`).
- `safeBinTrustedDirs` comes from config (`tools.exec.safeBinTrustedDirs` or per-agent `agents.list[].tools.exec.safeBinTrustedDirs`).
- `safeBinProfiles` comes from config (`tools.exec.safeBinProfiles` or per-agent `agents.list[].tools.exec.safeBinProfiles`). Per-agent profile keys override global keys.
- allowlist entries live in host-local `~/.openclaw/exec-approvals.json` under `agents.<id>.allowlist` (or via Control UI / `openclaw approvals allowlist ...`).
- `openclaw security audit` warns with `tools.exec.safe_bins_interpreter_unprofiled` when interpreter/runtime bins appear in `safeBins` without explicit profiles.
- `openclaw doctor --fix` can scaffold missing custom `safeBinProfiles.<bin>` entries as `{}` (review and tighten afterward). Interpreter/runtime bins are not auto-scaffolded.

Custom profile example:

```json5
{
  tools: {
    exec: {
      safeBins: ["jq", "myfilter"],
      safeBinProfiles: {
        myfilter: {
          minPositional: 0,
          maxPositional: 0,
          allowedValueFlags: ["-n", "--limit"],
          deniedFlags: ["-f", "--file", "-c", "--command"],
        },
      },
    },
  },
}
```

If you explicitly opt `jq` into `safeBins`, OpenClaw still rejects the `env` builtin in safe-bin
mode so `jq -n env` cannot dump the host process environment without an explicit allowlist path
or approval prompt.

## Interpreter/runtime commands

Approval-backed interpreter/runtime runs are intentionally conservative:

- Exact argv/cwd/env context is always bound.
- Direct shell script and direct runtime file forms are best-effort bound to one concrete local
  file snapshot.
- Common package-manager wrapper forms that still resolve to one direct local file (for example
  `pnpm exec`, `pnpm node`, `npm exec`, `npx`) are unwrapped before binding.
- If OpenClaw cannot identify exactly one concrete local file for an interpreter/runtime command
  (for example package scripts, eval forms, runtime-specific loader chains, or ambiguous multi-file
  forms), approval-backed execution is denied instead of claiming semantic coverage it does not
  have.
- For those workflows, prefer sandboxing, a separate host boundary, or an explicit trusted
  allowlist/full workflow where the operator accepts the broader runtime semantics.

When approvals are required, the exec tool returns immediately with an approval id. Use that id to
correlate later system events (`Exec finished` / `Exec denied`). If no decision arrives before the
timeout, the request is treated as an approval timeout and surfaced as a denial reason.

### Followup delivery behavior

After an approved async exec finishes, OpenClaw sends a followup `agent` turn to the same session.

- If a valid external delivery target exists (deliverable channel plus target `to`), followup delivery uses that channel.
- In webchat-only or internal-session flows with no external target, followup delivery stays session-only (`deliver: false`).
- If a caller explicitly requests strict external delivery with no resolvable external channel, the request fails with `INVALID_REQUEST`.
- If `bestEffortDeliver` is enabled and no external channel can be resolved, delivery is downgraded to session-only instead of failing.

## Approval forwarding to chat channels

You can forward exec approval prompts to any chat channel (including plugin channels) and approve
them with `/approve`. This uses the normal outbound delivery pipeline.

Config:

```json5
{
  approvals: {
    exec: {
      enabled: true,
      mode: "session", // "session" | "targets" | "both"
      agentFilter: ["main"],
      sessionFilter: ["discord"], // substring or regex
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

Reply in chat:

```
/approve <id> allow-once
/approve <id> allow-always
/approve <id> deny
```

The `/approve` command handles both exec approvals and plugin approvals. If the ID does not match a pending exec approval, it automatically checks plugin approvals instead.

### Plugin approval forwarding

Plugin approval forwarding uses the same delivery pipeline as exec approvals but has its own
independent config under `approvals.plugin`. Enabling or disabling one does not affect the other.

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [
        { channel: "slack", to: "U12345678" },
        { channel: "telegram", to: "123456789" },
      ],
    },
  },
}
```

The config shape is identical to `approvals.exec`: `enabled`, `mode`, `agentFilter`,
`sessionFilter`, and `targets` work the same way.

Channels that support shared interactive replies render the same approval buttons for both exec and
plugin approvals. Channels without shared interactive UI fall back to plain text with `/approve`
instructions.

### Same-chat approvals on any channel

When an exec or plugin approval request originates from a deliverable chat surface, the same chat
can now approve it with `/approve` by default. This applies to channels such as Slack, Matrix, and
Microsoft Teams in addition to the existing Web UI and terminal UI flows.

This shared text-command path uses the normal channel auth model for that conversation. If the
originating chat can already send commands and receive replies, approval requests no longer need a
separate native delivery adapter just to stay pending.

Discord and Telegram also support same-chat `/approve`, but those channels still use their
resolved approver list for authorization even when native approval delivery is disabled.

For Telegram and other native approval clients that call the Gateway directly,
this fallback is intentionally bounded to "approval not found" failures. A real
exec approval denial/error does not silently retry as a plugin approval.

### Native approval delivery

Some channels can also act as native approval clients. Native clients add approver DMs, origin-chat
fanout, and channel-specific interactive approval UX on top of the shared same-chat `/approve`
flow.

When native approval cards/buttons are available, that native UI is the primary
agent-facing path. The agent should not also echo a duplicate plain chat
`/approve` command unless the tool result says chat approvals are unavailable or
manual approval is the only remaining path.

Generic model:

- host exec policy still decides whether exec approval is required
- `approvals.exec` controls forwarding approval prompts to other chat destinations
- `channels.<channel>.execApprovals` controls whether that channel acts as a native approval client

Native approval clients auto-enable DM-first delivery when all of these are true:

- the channel supports native approval delivery
- approvers can be resolved from explicit `execApprovals.approvers` or that
  channel's documented fallback sources
- `channels.<channel>.execApprovals.enabled` is unset or `"auto"`

Set `enabled: false` to disable a native approval client explicitly. Set `enabled: true` to force
it on when approvers resolve. Public origin-chat delivery stays explicit through
`channels.<channel>.execApprovals.target`.

FAQ: [Why are there two exec approval configs for chat approvals?](/help/faq-first-run#why-are-there-two-exec-approval-configs-for-chat-approvals)

- Discord: `channels.discord.execApprovals.*`
- Slack: `channels.slack.execApprovals.*`
- Telegram: `channels.telegram.execApprovals.*`

These native approval clients add DM routing and optional channel fanout on top of the shared
same-chat `/approve` flow and shared approval buttons.

Shared behavior:

- Slack, Matrix, Microsoft Teams, and similar deliverable chats use the normal channel auth model
  for same-chat `/approve`
- when a native approval client auto-enables, the default native delivery target is approver DMs
- for Discord and Telegram, only resolved approvers can approve or deny
- Discord approvers can be explicit (`execApprovals.approvers`) or inferred from `commands.ownerAllowFrom`
- Telegram approvers can be explicit (`execApprovals.approvers`) or inferred from existing owner config (`allowFrom`, plus direct-message `defaultTo` where supported)
- Slack approvers can be explicit (`execApprovals.approvers`) or inferred from `commands.ownerAllowFrom`
- Slack native buttons preserve approval id kind, so `plugin:` ids can resolve plugin approvals
  without a second Slack-local fallback layer
- Matrix native DM/channel routing and reaction shortcuts handle both exec and plugin approvals;
  plugin authorization still comes from `channels.matrix.dm.allowFrom`
- Matrix native prompts include `com.openclaw.approval` custom event content on the first prompt
  event so OpenClaw-aware Matrix clients can read structured approval state while stock clients
  keep the plain-text `/approve` fallback
- the requester does not need to be an approver
- the originating chat can approve directly with `/approve` when that chat already supports commands and replies
- native Discord approval buttons route by approval id kind: `plugin:` ids go
  straight to plugin approvals, everything else goes to exec approvals
- native Telegram approval buttons follow the same bounded exec-to-plugin fallback as `/approve`
- when native `target` enables origin-chat delivery, approval prompts include the command text
- pending exec approvals expire after 30 minutes by default
- if no operator UI or configured approval client can accept the request, the prompt falls back to `askFallback`

Telegram defaults to approver DMs (`target: "dm"`). You can switch to `channel` or `both` when you
want approval prompts to appear in the originating Telegram chat/topic as well. For Telegram forum
topics, OpenClaw preserves the topic for the approval prompt and the post-approval follow-up.

See:

- [Discord](/channels/discord)
- [Telegram](/channels/telegram)

### macOS IPC flow

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + approvals + system.run)
```

Security notes:

- Unix socket mode `0600`, token stored in `exec-approvals.json`.
- Same-UID peer check.
- Challenge/response (nonce + HMAC token + request hash) + short TTL.

## Related

- [Exec approvals](/tools/exec-approvals) — core policy and approval flow
- [Exec tool](/tools/exec)
- [Elevated mode](/tools/elevated)
- [Skills](/tools/skills) — skill-backed auto-allow behavior
