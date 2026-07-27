---
summary: "How OpenClaw handles local file access safely, and why the optional fs-safe Python helper is off by default"
read_when:
  - Changing file access, archive extraction, workspace storage, or plugin filesystem helpers
title: "Secure file operations"
---

OpenClaw uses [`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe) for security-sensitive local file operations: root-bounded reads/writes, atomic replacement, archive extraction, temp workspaces, JSON state, and secret-file handling.

It is a **library guardrail** for trusted OpenClaw code that receives untrusted path names, not a sandbox. Host filesystem permissions, OS users, containers, and the agent/tool policy still define the real blast radius.

## Default: no Python helper

OpenClaw sets the fs-safe POSIX Python helper to **off** by default:

- the gateway should not spawn a persistent Python sidecar unless an operator opts in;
- most installs do not need the extra parent-directory mutation hardening;
- disabling Python keeps runtime behavior predictable across desktop, Docker, CI, and bundled-app environments.

OpenClaw only changes the _default_. An explicit setting always wins:

```bash
# Default OpenClaw behavior: Node-only fs-safe fallbacks.
OPENCLAW_FS_SAFE_PYTHON_MODE=off

# Opt into the helper when available, falling back if unavailable.
OPENCLAW_FS_SAFE_PYTHON_MODE=auto

# Fail closed if the helper cannot start.
OPENCLAW_FS_SAFE_PYTHON_MODE=require

# Optional explicit interpreter path.
OPENCLAW_FS_SAFE_PYTHON=/usr/bin/python3
```

The generic fs-safe env names also work: `FS_SAFE_PYTHON_MODE` and `FS_SAFE_PYTHON`.

Use `require` (not `auto`) when the helper is part of your security posture; `auto` silently falls back to Node-only behavior if the helper cannot start.

## What stays protected without Python

With the helper off, OpenClaw still gets fs-safe's Node-only guardrails:

- rejects relative-path escapes (`..`), absolute paths, and path separators where only bare names are allowed;
- resolves operations through a trusted root handle instead of ad-hoc `path.resolve(...).startsWith(...)` checks;
- refuses symlink and hardlink patterns on APIs that require that policy;
- opens files with identity checks where the API returns or consumes file contents;
- writes state/config files via atomic sibling-temp + rename;
- enforces byte limits for reads and archive extraction;
- applies private file modes for secrets and state files where the API requires them.

This covers OpenClaw's normal threat model: trusted gateway code handling untrusted model/plugin/channel path input inside a single trusted operator boundary.

## What Python adds

On POSIX, the optional helper keeps one persistent Python process and uses fd-relative filesystem operations for parent-directory mutations: rename, remove, mkdir, stat/list, and some write paths.

That narrows same-UID race windows where another process swaps a parent directory between validation and mutation — defense in depth on hosts where untrusted local processes can modify the same directories OpenClaw operates in.

If your deployment has that risk and Python is guaranteed to exist, set:

```bash
OPENCLAW_FS_SAFE_PYTHON_MODE=require
```

## Plugin and core guidance

- Plugin-facing file access should go through `openclaw/plugin-sdk/*` helpers, not raw `fs`, when a path comes from a message, model output, config, or plugin input.
- Core code should use the fs-safe wrappers under `src/infra/*` so OpenClaw's process policy applies consistently.
- Archive extraction should use the fs-safe archive helpers with explicit size, entry-count, link, and destination limits.
- Secrets should use OpenClaw secret helpers or fs-safe secret/private-state helpers; do not hand-roll mode checks around `fs.writeFile`.
- For hostile local-user isolation, do not rely on fs-safe alone. Run separate gateways under separate OS users/hosts, or use sandboxing.

Related: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing), [Exec approvals](/tools/exec-approvals), [Secrets](/gateway/secrets).
