---
summary: "Session permission modes, workspace boundaries, and escalation reviewers"
read_when:
  - Choosing a permission mode for an agent session
  - Understanding who reviews an exec escalation
  - Comparing session permissions with sandbox and tool policy
title: Session permission modes
---

Session permission modes set one session's filesystem boundary and exec escalation reviewer. The boundary is the session's canonical `sessionRoot`; the mode determines what may happen inside or outside it.

| Mode        | Filesystem access                                 | Exec escalation reviewer              |
| ----------- | ------------------------------------------------- | ------------------------------------- |
| `read-only` | Reads under `sessionRoot`; mutation tools omitted | None; exec is denied                  |
| `guarded`   | Reads and writes under `sessionRoot`              | A human after the allowlist fast path |
| `workspace` | Reads and writes under `sessionRoot`              | LLM review, with human fallback       |
| `full`      | Unrestricted filesystem access                    | None                                  |

`full` requires `operator.admin`. The other modes require `operator.write`.

## Session root and defaults

The Gateway records `sessionRoot` when it creates the session. An explicit working directory becomes the root after canonical path resolution. A session without an explicit working directory uses the selected agent's canonical workspace.

Managed worktree sessions use the worktree checkout as `sessionRoot`. A nested working directory remains the runtime `cwd`, so relative paths start there while filesystem containment covers the whole checkout.

A new managed worktree session defaults to `workspace` when no mode is specified. Other sessions with no recorded mode keep the existing config-driven behavior.

## Policy precedence and clamping

An explicit session mode takes precedence over the session's legacy `execSecurity` and `execAsk` overrides. When the mode is unset, those fields and the normal global or per-agent configuration continue to work as before.

Host approval-file floors, sandbox restrictions, and tool allow/deny policy can only make the effective result stricter. A harness may also clamp an unsupported mode to a compatible safer policy tuple; it does not combine tuple fields into a less restrictive posture.

For the independent sandbox, tool-policy, and elevated-exec controls, see [Sandbox vs tool policy vs elevated](/gateway/sandbox-vs-tool-policy-vs-elevated).
