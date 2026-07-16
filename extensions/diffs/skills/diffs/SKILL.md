---
name: diffs
description: Use the diffs tool to produce real, shareable diffs (viewer URL, file artifact, or both) instead of manual edit summaries.
---

When you need to show edits as a real diff, prefer the `diffs` tool instead of writing a manual summary.

The `diffs` tool accepts either `before` + `after` text, or a unified `patch` string.

Use `mode=view` when you want an interactive gateway-hosted viewer. After the tool returns, use `details.viewerUrl` with the canvas tool via `canvas present` or `canvas navigate`.
If the deployment uses a loopback trusted proxy (for example Tailscale Serve with `gateway.trustedProxies` including `127.0.0.1`), raw loopback viewer requests can fail closed without forwarded client-IP headers. In that topology, prefer `mode=file` / `mode=both`, or use a configured `viewerBaseUrl` / explicit proxy/public `baseUrl` when you need a shareable viewer URL.

Use `mode=file` when you need a rendered file artifact. Set `fileFormat=png` (default) or `fileFormat=pdf`. The tool result includes `details.filePath`.

For large or high-fidelity files, use `fileQuality` (`standard`|`hq`|`print`) and optionally override `fileScale`/`fileMaxWidth`.

When you need to deliver the rendered file to a user or channel, do not rely on the raw tool-result renderer. Instead, call the `message` tool and pass `details.filePath` through `path` or `filePath`.

Use `mode=both` when you want both the gateway viewer URL and the rendered artifact.

If the user has configured diffs plugin defaults, prefer omitting `mode`, `theme`, `layout`, and related presentation options unless you need to override them for this specific diff.

Include `path` for before/after text when you know the file name.
