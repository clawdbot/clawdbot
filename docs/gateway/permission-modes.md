---
summary: "Session permission modes, workspace boundaries, and escalation reviewers"
read_when:
  - Choosing a permission mode for an agent session
  - Understanding who reviews an exec escalation
  - Comparing session permissions with sandbox and tool policy
title: Session permission modes
---

Session permission modes set one session's filesystem boundary and exec escalation reviewer. The boundary is the session's recorded canonical `sessionRoot`, or the selected agent's canonical workspace when no root is recorded. The mode determines what may happen inside or outside that boundary.

| Mode        | Filesystem access                                         | Exec escalation reviewer              |
| ----------- | --------------------------------------------------------- | ------------------------------------- |
| `read-only` | Reads under `sessionRoot`; managed mutation tools omitted | None; exec is denied                  |
| `guarded`   | Reads and writes under `sessionRoot`                      | A human after the allowlist fast path |
| `workspace` | Reads and writes under `sessionRoot`                      | LLM review, with human fallback       |
| `full`      | Unrestricted filesystem access                            | None                                  |

These tool-visibility and exec rules describe OpenClaw-managed tools. Native harnesses can retain their own tool surface under their permission controls; see [Codex runtime policy](/plugins/codex-harness-runtime).

`full` requires `operator.admin`. The other modes require `operator.write`.

## Session root and defaults

A permission mode can be set on any session. When a session has a recorded `sessionRoot`, that canonical path is its filesystem boundary. An explicit working directory and a managed worktree each pin their session's root. When no root is recorded, the boundary defaults to the selected agent's canonical workspace when the run is prepared.

Managed worktree sessions use the worktree checkout as `sessionRoot`. A nested working directory remains the runtime `cwd`, so relative paths start there while filesystem containment covers the whole checkout.

File tools recognize aliases of the session's trusted root and working directory, including absolute paths using those aliases. This does not expand the boundary: unrelated external symlinks pointing inward remain denied, as do symlinks and raw `symlink/..` traversal that escape the root. In `read-only` mode, OpenClaw-managed mutation tools remain omitted.

New sessions, including managed worktree sessions, inherit the configured global or per-agent tool/exec policy when no mode is specified. Creating a worktree pins the working directory without selecting a permission mode. Explicit modes and modes already saved on existing sessions remain unchanged.

The Control UI permission picker labels Default with the agent's resolved exec posture when it matches a session mode, for example **Default (Guarded)** for `tools.exec.mode: "ask"` without a stricter host approval policy. Resolution includes global settings, agent overrides, and host approval floors. Without those settings or sandboxing, the default is full access. Allowlist-only policy and non-equivalent `security`/`ask` pairs, including `ask: "always"`, keep the plain **Default** label. Agents whose sandbox configuration could apply to their sessions also keep plain **Default**, because effective policy cannot be stated at agent scope. This is display metadata, not an authorization decision or a filesystem-access guarantee; tool policy still applies. Selecting Default clears the session override; it does not save the displayed mode into the session.

## Policy precedence and clamping

Session-wide exec policy belongs to the permission mode. When the mode is unset, normal global or per-agent configuration applies. `/exec security=... ask=...` applies only to its message and can only tighten an explicit session mode; `host` and `node` remain session placement defaults. See [Exec session overrides](/tools/exec#session-overrides-exec).

Before resuming sessions after upgrading a store with legacy session exec policy, run `openclaw doctor --fix`; the runtime no longer reads that policy. Missing policy values inherit the layered global and per-agent exec policy. When historical sandbox availability is unknown, migration uses the stricter sandbox base for automatic host selection. Restrictive policies migrate without broadening exec access to `read-only` or `guarded`. Existing permission modes remain unchanged. Legacy full-access policy is removed with a notice so configuration applies, never converted into a `full` permission grant.

The retired `execSecurity` and `execAsk` fields remain in the protocol v4 schemas for `sessions.patch` and `sessions.patchMany`. Requests containing either field, including `null`, are rejected with `INVALID_REQUEST` and guidance to set `permissionMode` (`read-only`, `guarded`, `workspace`, or `full`) or use `/exec` for one run. Neither field is stored as runtime session policy.

An explicit `full` mode is the admin-authorized exception to host approval-file floors: its OpenClaw exec policy remains `full` with approvals off unless a turn-scoped override tightens it. Approval-file floors continue to tighten config-driven exec policy, unset modes, and every non-full session mode. Tightening a full session's security restores those floors; tightening only `ask` does not. Sandbox restrictions and tool allow/deny policy remain independent, and a harness may clamp an unsupported mode to a compatible safer policy tuple. Codex also continues to honor externally enforced `requirements.toml` constraints.

For the independent sandbox, tool-policy, and elevated-exec controls, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).
