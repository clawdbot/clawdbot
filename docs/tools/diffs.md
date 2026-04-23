---
summary: "Read-only diff viewer and file renderer for agents (optional plugin tool)"
title: "Diffs"
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff file
  - You need controlled, temporary diff artifacts with secure defaults
---

`diffs` is an optional plugin tool with short built-in system guidance and a companion skill that turns change content into a read-only diff artifact for agents.

It accepts either:

- `before` and `after` text
- a unified `patch`

It can return:

- a gateway viewer URL for canvas presentation
- a rendered file path (PNG or PDF) for message delivery
- both outputs in one call

When enabled, the plugin prepends concise usage guidance into system-prompt space and also exposes a detailed skill for cases where the agent needs fuller instructions.

## Quick start

1. Enable the plugin.
2. Call `diffs` with `mode: "view"` for canvas-first flows.
3. Call `diffs` with `mode: "file"` for chat file delivery flows.
4. Call `diffs` with `mode: "both"` when you need both artifacts.

## Enable the plugin

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
      },
    },
  },
}
```

## Disable built-in system guidance

If you want to keep the `diffs` tool enabled but disable its built-in system-prompt guidance, set `plugins.entries.diffs.hooks.allowPromptInjection` to `false`:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
      },
    },
  },
}
```

This blocks the diffs plugin's `before_prompt_build` hook while keeping the plugin, tool, and companion skill available.

If you want to disable both the guidance and the tool, disable the plugin instead.

## Typical agent workflow

1. Agent calls `diffs`.
2. Agent reads `details` fields.
3. Agent either:
   - opens `details.viewerUrl` with `canvas present`
   - sends `details.filePath` with `message` using `path` or `filePath`
   - does both

## Input examples

Before and after:

```json
{
  "before": "# Hello\n\nOne",
  "after": "# Hello\n\nTwo",
  "path": "docs/example.md",
  "mode": "view"
}
```

Patch:

```json
{
  "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  "mode": "both"
}
```

## Tool input reference

All fields are optional unless noted:

- `before` (`string`): original text. Required with `after` when `patch` is omitted.
- `after` (`string`): updated text. Required with `before` when `patch` is omitted.
- `patch` (`string`): unified diff text. Mutually exclusive with `before` and `after`.
- `path` (`string`): display filename for before and after mode.
- `lang` (`string`): language override hint for before and after mode. Unknown values fall back to plain text.
- `title` (`string`): viewer title override.
- `mode` (`"view" | "file" | "both"`): output mode. Defaults to plugin default `defaults.mode`.
  Deprecated alias: `"image"` behaves like `"file"` and is still accepted for backward compatibility.
- `theme` (`"light" | "dark"`): viewer theme. Defaults to plugin default `defaults.theme`.
- `layout` (`"unified" | "split"`): diff layout. Defaults to plugin default `defaults.layout`.
- `expandUnchanged` (`boolean`): expand unchanged sections when full context is available. Per-call option only (not a plugin default key).
- `fileFormat` (`"png" | "pdf"`): rendered file format. Defaults to plugin default `defaults.fileFormat`.
- `fileQuality` (`"standard" | "hq" | "print"`): quality preset for PNG or PDF rendering.
- `fileScale` (`number`): device scale override (`1`-`4`).
- `fileMaxWidth` (`number`): max render width in CSS pixels (`640`-`2400`).
- `ttlSeconds` (`number`): artifact TTL in seconds for viewer and standalone file outputs. Default 1800, max 21600.
- `baseUrl` (`string`): viewer URL origin override. Overrides plugin `viewerBaseUrl`. Must be `http` or `https`, no query/hash.

Legacy input aliases still accepted for backward compatibility:

- `format` -> `fileFormat`
- `imageFormat` -> `fileFormat`
- `imageQuality` -> `fileQuality`
- `imageScale` -> `fileScale`
- `imageMaxWidth` -> `fileMaxWidth`

Validation and limits:

- `before` and `after` each max 512 KiB.
- `patch` max 2 MiB.
- `path` max 2048 bytes.
- `lang` max 128 bytes.
- `title` max 1024 bytes.
- Patch complexity cap: max 128 files and 120000 total lines.
- `patch` and `before` or `after` together are rejected.
- Rendered file safety limits (apply to PNG and PDF):
  - `fileQuality: "standard"`: max 8 MP (8,000,000 rendered pixels).
  - `fileQuality: "hq"`: max 14 MP (14,000,000 rendered pixels).
  - `fileQuality: "print"`: max 24 MP (24,000,000 rendered pixels).
  - PDF also has a max of 50 pages.

## Output details contract

The tool returns structured metadata under `details`.

Shared fields for modes that create a viewer:

- `artifactId`
- `viewerUrl`
- `viewerPath`
- `title`
- `expiresAt`
- `inputKind`
- `fileCount`
- `mode`
- `context` (`agentId`, `sessionId`, `messageChannel`, `agentAccountId` when available)

File fields when PNG or PDF is rendered:

- `artifactId`
- `expiresAt`
- `filePath`
- `path` (same value as `filePath`, for message tool compatibility)
- `fileBytes`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`

Compatibility aliases also returned for existing callers:

- `format` (same value as `fileFormat`)
- `imagePath` (same value as `filePath`)
- `imageBytes` (same value as `fileBytes`)
- `imageQuality` (same value as `fileQuality`)
- `imageScale` (same value as `fileScale`)
- `imageMaxWidth` (same value as `fileMaxWidth`)

Mode behavior summary:

- `mode: "view"`: viewer fields only.
- `mode: "file"`: file fields only, no viewer artifact.
- `mode: "both"`: viewer fields plus file fields. If file rendering fails, viewer still returns with `fileError` and compatibility alias `imageError`.

## Collapsed unchanged sections

- The viewer can show rows like `N unmodified lines`.
- Expand controls on those rows are conditional and not guaranteed for every input kind.
- Expand controls appear when the rendered diff has expandable context data, which is typical for before and after input.
- For many unified patch inputs, omitted context bodies are not available in the parsed patch hunks, so the row can appear without expand controls. This is expected behavior.
- `expandUnchanged` applies only when expandable context exists.

## Plugin defaults

Set plugin-wide defaults in `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          defaults: {
            fontFamily: "Fira Code",
            fontSize: 15,
            lineSpacing: 1.6,
            layout: "unified",
            showLineNumbers: true,
            diffIndicators: "bars",
            wordWrap: true,
            background: true,
            theme: "dark",
            fileFormat: "png",
            fileQuality: "standard",
            fileScale: 2,
            fileMaxWidth: 960,
            mode: "both",
          },
        },
      },
    },
  },
}
```

Supported defaults:

- `fontFamily`
- `fontSize`
- `lineSpacing`
- `layout`
- `showLineNumbers`
- `diffIndicators`
- `wordWrap`
- `background`
- `theme`
- `fileFormat`
- `fileQuality`
- `fileScale`
- `fileMaxWidth`
- `mode`

Explicit tool parameters override these defaults.

Persistent viewer URL config:

- `viewerBaseUrl` (`string`, optional)
  - Plugin-owned fallback for returned viewer links when a tool call does not pass `baseUrl`.
  - Must be `http` or `https`, no query/hash.

Example:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          viewerBaseUrl: "https://gateway.example.com/openclaw",
        },
      },
    },
  },
}
```

## Security config

- `security.allowRemoteViewer` (`boolean`, default `false`)
  - `false`: non-loopback requests to viewer routes are denied.
  - `true`: remote viewers are allowed if tokenized path is valid.

Example:

```json5
{
  plugins: {
    entries: {
      diffs: {
        enabled: true,
        config: {
          security: {
            allowRemoteViewer: false,
          },
        },
      },
    },
  },
}
```

## Artifact lifecycle and storage

- Artifacts are stored under the temp subfolder: `$TMPDIR/openclaw-diffs`.
- Viewer artifact metadata contains:
  - random artifact ID (20 hex chars)
  - random token (48 hex chars)
  - `createdAt` and `expiresAt`
  - stored `viewer.html` path
- Default artifact TTL is 30 minutes when not specified.
- Maximum accepted viewer TTL is 6 hours.
- Cleanup runs opportunistically after artifact creation.
- Expired artifacts are deleted.
- Fallback cleanup removes stale folders older than 24 hours when metadata is missing.

## Viewer URL and network behavior

Viewer route:

- `/plugins/diffs/view/{artifactId}/{token}`

Viewer assets:

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`

The viewer document resolves those assets relative to the viewer URL, so an optional `baseUrl` path prefix is preserved for both asset requests too.

URL construction behavior:

- If tool-call `baseUrl` is provided, it is used after strict validation.
- Else if plugin `viewerBaseUrl` is configured, it is used.
- Without either override, viewer URL defaults to loopback `127.0.0.1`.
- If gateway bind mode is `custom` and `gateway.customBindHost` is set, that host is used.

`baseUrl` rules:

- Must be `http://` or `https://`.
- Query and hash are rejected.
- Origin plus optional base path is allowed.

## Security model

Viewer hardening:

- Loopback-only by default.
- Tokenized viewer paths with strict ID and token validation.
- Viewer response CSP:
  - `default-src 'none'`
  - scripts and assets only from self
  - no outbound `connect-src`
- Remote miss throttling when remote access is enabled:
  - 40 failures per 60 seconds
  - 60 second lockout (`429 Too Many Requests`)

File rendering hardening:

- Screenshot browser request routing is deny-by-default.
- Only local viewer assets from `http://127.0.0.1/plugins/diffs/assets/*` are allowed.
- External network requests are blocked.

## Browser requirements for file mode

`mode: "file"` and `mode: "both"` need a Chromium-compatible browser.

Resolution order:

1. `browser.executablePath` in OpenClaw config.
2. Environment variables:
   - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
   - `BROWSER_EXECUTABLE_PATH`
   - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`
3. Platform command/path discovery fallback.

Common failure text:

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

Fix by installing Chrome, Chromium, Edge, or Brave, or setting one of the executable path options above.

## Troubleshooting

Input validation errors:

- `Provide patch or both before and after text.`
  - Include both `before` and `after`, or provide `patch`.
- `Provide either patch or before/after input, not both.`
  - Do not mix input modes.
- `Invalid baseUrl: ...`
  - Use `http(s)` origin with optional path, no query/hash.
- `{field} exceeds maximum size (...)`
  - Reduce payload size.
- Large patch rejection
  - Reduce patch file count or total lines.

Viewer accessibility issues:

- Viewer URL resolves to `127.0.0.1` by default.
- For remote access scenarios, either:
  - set plugin `viewerBaseUrl`, or
  - pass `baseUrl` per tool call, or
  - use `gateway.bind=custom` and `gateway.customBindHost`
- If `gateway.trustedProxies` includes loopback for a same-host proxy (for example Tailscale Serve), raw loopback viewer requests without forwarded client-IP headers fail closed by design.
- For that proxy topology:
  - prefer `mode: "file"` or `mode: "both"` when you only need an attachment, or
  - intentionally enable `security.allowRemoteViewer` and set plugin `viewerBaseUrl` or pass a proxy/public `baseUrl` when you need a shareable viewer URL
- Enable `security.allowRemoteViewer` only when you intend external viewer access.

Unmodified-lines row has no expand button:

- This can happen for patch input when the patch does not carry expandable context.
- This is expected and does not indicate a viewer failure.

Artifact not found:

- Artifact expired due TTL.
- Token or path changed.
- Cleanup removed stale data.

## Operational guidance

- Prefer `mode: "view"` for local interactive reviews in canvas.
- Prefer `mode: "file"` for outbound chat channels that need an attachment.
- Keep `allowRemoteViewer` disabled unless your deployment requires remote viewer URLs.
- Set explicit short `ttlSeconds` for sensitive diffs.
- Avoid sending secrets in diff input when not required.
- If your channel compresses images aggressively (for example Telegram or WhatsApp), prefer PDF output (`fileFormat: "pdf"`).

Diff rendering engine:

- Powered by [Diffs](https://diffs.com).

## Related docs

- [Tools overview](/tools)
- [Plugins](/tools/plugin)
- [Browser](/tools/browser)
