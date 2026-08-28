---
summary: "Session permission modes, workspace boundaries, and escalation reviewers"
read_when:
  - Choosing a permission mode for an agent session
  - Understanding who reviews an exec escalation
  - Comparing session permissions with sandbox and tool policy
title: Session permission modes
---

Session permission modes set one session's filesystem boundary and exec escalation reviewer. The boundary is the session's recorded canonical `sessionRoot`, or the selected agent's canonical workspace when no root is recorded. The mode determines what may happen inside or outside that boundary.

| Mode        | Filesystem access                                 | Exec escalation reviewer              |
| ----------- | ------------------------------------------------- | ------------------------------------- |
| `read-only` | Reads under `sessionRoot`; mutation tools omitted | None; exec is denied                  |
| `guarded`   | Reads and writes under `sessionRoot`              | A human after the allowlist fast path |
| `workspace` | Reads and writes under `sessionRoot`              | LLM review, with human fallback       |
| `full`      | Unrestricted filesystem access                    | None                                  |

`full` requires `operator.admin`. The other modes require `operator.write`.

## Session root and defaults

A permission mode can be set on any session. When a session has a recorded `sessionRoot`, that canonical path is its filesystem boundary. An explicit working directory and a managed worktree each pin their session's root. When no root is recorded, the boundary defaults to the selected agent's canonical workspace when the run is prepared.

Managed worktree sessions use the worktree checkout as `sessionRoot`. A nested working directory remains the runtime `cwd`, so relative paths start there while filesystem containment covers the whole checkout.

File tools recognize aliases of the session's trusted root and working directory, including absolute paths using those aliases. This does not expand the boundary: unrelated external symlinks pointing inward remain denied, as do symlinks and raw `symlink/..` traversal that escape the root. `read-only` sessions still omit mutation tools.

New sessions, including managed worktree sessions, inherit the configured global or per-agent tool/exec policy when no mode is specified. Creating a worktree pins the working directory without selecting a permission mode. Explicit modes and modes already saved on existing sessions remain unchanged.

## Policy precedence and clamping

An explicit session mode takes precedence over the session's legacy `execSecurity` and `execAsk` overrides. When the mode is unset, those fields and the normal global or per-agent configuration continue to work as before.

An explicit `full` mode is the admin-authorized exception to host approval-file floors: its OpenClaw exec policy remains `full` with approvals off. Approval-file floors continue to tighten config-driven exec policy, legacy session overrides, unset modes, and every non-full session mode. Sandbox restrictions and tool allow/deny policy remain independent, and a harness may clamp an unsupported mode to a compatible safer policy tuple. Codex also continues to honor externally enforced `requirements.toml` constraints.

For the independent sandbox, tool-policy, and elevated-exec controls, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).
