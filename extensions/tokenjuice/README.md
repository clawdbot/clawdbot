# @openclaw/tokenjuice

Official Tokenjuice output compaction plugin for OpenClaw.

Tokenjuice compacts noisy `exec` and `bash` tool results after commands run, before the result is fed back into the active agent session. It does not rewrite commands, rerun commands, or change exit codes.

## Install

```bash
openclaw plugins install @openclaw/tokenjuice
```

Restart the Gateway after installing or updating the plugin.

## Enable

```bash
openclaw config set plugins.entries.tokenjuice.enabled true
```

Equivalent:

```bash
openclaw plugins enable tokenjuice
```

## Docs

- https://docs.openclaw.ai/tools/tokenjuice

## Package

- Plugin id: `tokenjuice`
- Package: `@openclaw/tokenjuice`
- Minimum OpenClaw host: `2026.5.28`
