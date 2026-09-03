---
summary: "How OpenClaw handles local file access safely, and why optional fs-safe native acceleration is off by default"
read_when:
  - Changing file access, archive extraction, workspace storage, or plugin filesystem helpers
title: "Secure file operations"
---

OpenClaw uses [`@openclaw/fs-safe`](https://github.com/openclaw/fs-safe) for security-sensitive local file operations: root-bounded reads/writes, atomic replacement, archive extraction, temp workspaces, JSON state, and secret-file handling.

It is a **library guardrail** for trusted OpenClaw code that receives untrusted path names, not a sandbox. Host filesystem permissions, OS users, containers, and the agent/tool policy still define the real blast radius.

## Default: JavaScript fallback

OpenClaw sets fs-safe's optional native helper to **off** by default:

- the guarded JavaScript paths support OpenClaw's normal filesystem operations;
- disabling native loading keeps runtime behavior deterministic across desktop, Docker, CI, and bundled-app environments.

fs-safe publishes prebuilt native helpers as optional platform packages for Linux x64/arm64 (glibc and musl), macOS x64/arm64, and Windows x64. A normal package install selects the matching package without a compiler. OpenClaw loads it through fs-safe's own dependency scope, including nested pnpm installs. Installs that omit optional dependencies retain the guarded JavaScript path; `require` mode fails when the binding is unavailable.

OpenClaw only changes the _default_. An explicit setting always wins:

```bash
# Default OpenClaw behavior: guarded JavaScript fs-safe paths.
OPENCLAW_FS_SAFE_NATIVE_MODE=off

# Prefer native primitives when the installed platform helper loads.
OPENCLAW_FS_SAFE_NATIVE_MODE=auto

# Fail closed when an operation needs native support and the binding is unavailable.
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

The generic fs-safe environment name also works: `FS_SAFE_NATIVE_MODE`.

fs-safe still maps the retired `FS_SAFE_PYTHON_MODE` and `OPENCLAW_FS_SAFE_PYTHON_MODE` values to native modes with a deprecation warning. Replace them with `FS_SAFE_NATIVE_MODE` or `OPENCLAW_FS_SAFE_NATIVE_MODE`; Python interpreter path settings are no longer used.

Use `require` (not `auto`) when native primitives are part of your security posture. `auto` uses the guarded JavaScript implementation when the platform binding is unavailable.

## What stays protected without native acceleration

With the helper off, OpenClaw still gets fs-safe's Node-only guardrails:

- rejects relative-path escapes (`..`), absolute paths, and path separators where only bare names are allowed;
- resolves operations through a trusted root handle instead of ad-hoc `path.resolve(...).startsWith(...)` checks;
- refuses symlink and hardlink patterns on APIs that require that policy;
- opens files with identity checks where the API returns or consumes file contents;
- writes state/config files via atomic sibling-temp + rename;
- enforces byte limits for reads and archive extraction;
- applies private file modes for secrets and state files where the API requires them.

This covers OpenClaw's normal threat model: trusted gateway code handling untrusted model/plugin/channel path input inside a single trusted operator boundary.

## What native acceleration adds

The native helper provides policy-free filesystem primitives used by fs-safe for create-only writes, guarded hard-link publication, asynchronous sidecar creation, and explicit no-replace rename publication. Linux uses `openat2` and `renameat2`; macOS uses descriptor-relative component checks and `renameatx_np`; Windows uses handle-relative operations and replacement-disabled rename.

The TypeScript layer still owns policy, validation, retries, cleanup, and fallback decisions. Native support narrows filesystem race windows; it does not turn fs-safe into a sandbox.

If your package deployment requires those native primitives, set:

```bash
OPENCLAW_FS_SAFE_NATIVE_MODE=require
```

In `require` mode, an unavailable or unloadable helper causes `helper-unavailable` instead of silently using the JavaScript path. Standalone sealed worker bundles have no dependency tree and explicitly disable native loading, even when the host sets a mode override.

## Plugin and core guidance

- Plugin-facing file access should go through `openclaw/plugin-sdk/*` helpers, not raw `fs`, when a path comes from a message, model output, config, or plugin input.
- Core code should use the fs-safe wrappers under `src/infra/*` so OpenClaw's process policy applies consistently.
- Archive extraction should use the fs-safe archive helpers with explicit size, entry-count, link, and destination limits.
- Secrets should use OpenClaw secret helpers or fs-safe secret/private-state helpers; do not hand-roll mode checks around `fs.writeFile`.
- For hostile local-user isolation, do not rely on fs-safe alone. Run separate gateways under separate OS users/hosts, or use sandboxing.

Related: [Security](/gateway/security), [Sandboxing](/gateway/sandboxing), [Exec approvals](/tools/exec-approvals), [Secrets](/gateway/secrets).
