---
doc-schema-version: 1
summary: "Compact noisy exec and bash tool results with the optional Tokenjuice plugin"
title: "Tokenjuice"
read_when:
  - You want shorter `exec` or `bash` tool results in OpenClaw
  - You want to install or enable the Tokenjuice plugin
  - You need to understand what tokenjuice changes and what it leaves raw
---

`tokenjuice` is an optional external plugin that compacts noisy `exec` and `bash`
tool results after the command has already run.

It changes the returned `tool_result`, not the command itself. Tokenjuice does
not rewrite shell input, rerun commands, or change exit codes.

Today this applies to OpenClaw embedded runs and OpenClaw dynamic tools in the Codex
app-server harness. Native codex-rs `bash`/`exec` results mirrored from the Codex
app-server harness are not compacted: they pass through the middleware, but the
codex-rs protocol has no hook to replace the tool response, so the trimmed output
is discarded and the original result is returned to the session.

## Enable the plugin

Install once:

```bash
openclaw plugins install clawhub:@openclaw/tokenjuice
```

Then enable it:

```bash
openclaw config set plugins.entries.tokenjuice.enabled true
```

Equivalent:

```bash
openclaw plugins enable tokenjuice
```

If you prefer editing config directly:

```json5
{
  plugins: {
    entries: {
      tokenjuice: {
        enabled: true,
      },
    },
  },
}
```

## What tokenjuice changes

- Compacts noisy `exec` and `bash` results before they are fed back into the session.
- Keeps the original command execution untouched.
- Applies a safe-inventory policy: exact file-content reads stay raw, standalone repository-inventory commands can compact, and unsafe mixed command sequences stay raw.
- Stays opt-in: disable the plugin if you want verbatim output everywhere.

## Verify it is working

1. Enable the plugin.
2. Start a session that can call `exec` on the OpenClaw-embedded path.
3. Run a noisy command such as `git status`.
4. Check that the returned tool result is shorter and more structured than the raw shell output.

This check only applies to OpenClaw-embedded or OpenClaw dynamic tools. Native
codex-rs `bash`/`exec` results in the Codex app-server harness are not compacted.

## Disable the plugin

```bash
openclaw config set plugins.entries.tokenjuice.enabled false
```

Or:

```bash
openclaw plugins disable tokenjuice
```

## Related

- [Exec tool](/tools/exec)
- [Thinking levels](/tools/thinking)
- [Context engine](/concepts/context-engine)
