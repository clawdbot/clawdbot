---
summary: "Read-only diff viewer and file renderer for agents (optional plugin tool)"
title: "Diffs"
sidebarTitle: "Diffs"
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

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install diffs
    ```
  </Step>
  <Step title="Enable the plugin">
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
  </Step>
  <Step title="Pick a mode">
    <Tabs>
      <Tab title="view">
        Canvas-first flows: agents call `diffs` with `mode: "view"` and open `details.viewerUrl` with `canvas present`.
      </Tab>
      <Tab title="file">
        Chat file delivery: agents call `diffs` with `mode: "file"` and send `details.filePath` with `message` using `path` or `filePath`.
      </Tab>
      <Tab title="both">
        Combined: agents call `diffs` with `mode: "both"` to get both artifacts in one call.
      </Tab>
    </Tabs>
  </Step>
</Steps>

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

<Steps>
  <Step title="Call diffs">
    Agent calls the `diffs` tool with input.
  </Step>
  <Step title="Read details">
    Agent reads `details` fields from the response.
  </Step>
  <Step title="Present">
    Agent either opens `details.viewerUrl` with `canvas present`, sends `details.filePath` with `message` using `path` or `filePath`, or does both.
  </Step>
</Steps>

## Input examples

<Tabs>
  <Tab title="Before and after">
    ```json
    {
      "before": "# Hello\n\nOne",
      "after": "# Hello\n\nTwo",
      "path": "docs/example.md",
      "mode": "view"
    }
    ```
  </Tab>
  <Tab title="Patch">
    ```json
    {
      "patch": "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
      "mode": "both"
    }
    ```
  </Tab>
</Tabs>

## Tool input reference

All fields are optional unless noted.

<ParamField path="before" type="string">
  Original text. Required with `after` when `patch` is omitted.
</ParamField>
<ParamField path="after" type="string">
  Updated text. Required with `before` when `patch` is omitted.
</ParamField>
<ParamField path="patch" type="string">
  Unified diff text. Mutually exclusive with `before` and `after`.
</ParamField>
<ParamField path="path" type="string">
  Display filename for before and after mode.
</ParamField>
<ParamField path="lang" type="string">
  Language override hint for before and after mode. Unknown values fall back to plain text.
</ParamField>
<ParamField path="title" type="string">
  Viewer title override.
</ParamField>
<ParamField path="mode" type='"view" | "file" | "both"'>
  Output mode. Defaults to plugin default `defaults.mode`. Deprecated alias: `"image"` behaves like `"file"` and is still accepted for backward compatibility.
</ParamField>
<ParamField path="theme" type='"light" | "dark"'>
  Viewer theme. Defaults to plugin default `defaults.theme`.
</ParamField>
<ParamField path="layout" type='"unified" | "split"'>
  Diff layout. Defaults to plugin default `defaults.layout`.
</ParamField>
<ParamField path="expandUnchanged" type="boolean">
  Expand unchanged sections when full context is available. Per-call option only (not a plugin default key).
</ParamField>
<ParamField path="fileFormat" type='"png" | "pdf"'>
  Rendered file format. Defaults to plugin default `defaults.fileFormat`.
</ParamField>
<ParamField path="fileQuality" type='"standard" | "hq" | "print"'>
  Quality preset for PNG or PDF rendering.
</ParamField>
<ParamField path="fileScale" type="number">
  Device scale override (`1`-`4`).
</ParamField>
<ParamField path="fileMaxWidth" type="number">
  Max render width in CSS pixels (`640`-`2400`).
</ParamField>
<ParamField path="ttlSeconds" type="number" default="1800">
  Artifact TTL in seconds for viewer and standalone file outputs. Max 21600.
</ParamField>
<ParamField path="baseUrl" type="string">
  Viewer URL origin override. Overrides plugin `viewerBaseUrl`. Must be `http` or `https`, no query/hash.
</ParamField>

<AccordionGroup>
  <Accordion title="Legacy input aliases">
    Still accepted for backward compatibility:

    - `format` -> `fileFormat`
    - `imageFormat` -> `fileFormat`
    - `imageQuality` -> `fileQuality`
    - `imageScale` -> `fileScale`
    - `imageMaxWidth` -> `fileMaxWidth`

  </Accordion>
  <Accordion title="Validation and limits">
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

  </Accordion>
</AccordionGroup>

## Output details contract

The tool returns structured metadata under `details`.

<AccordionGroup>
  <Accordion title="Viewer fields">
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

  </Accordion>
  <Accordion title="File fields">
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

  </Accordion>
  <Accordion title="Compatibility aliases">
    Also returned for existing callers:

    - `format` (same value as `fileFormat`)
    - `imagePath` (same value as `filePath`)
    - `imageBytes` (same value as `fileBytes`)
    - `imageQuality` (same value as `fileQuality`)
    - `imageScale` (same value as `fileScale`)
    - `imageMaxWidth` (same value as `fileMaxWidth`)

  </Accordion>
</AccordionGroup>

Mode behavior summary:

| Mode     | What is returned                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `"view"` | Viewer fields only.                                                                                                    |
| `"file"` | File fields only, no viewer artifact.                                                                                  |
| `"both"` | Viewer fields plus file fields. If file rendering fails, viewer still returns with `fileError` and `imageError` alias. |

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

### Persistent viewer URL config

<ParamField path="viewerBaseUrl" type="string">
  Plugin-owned fallback for returned viewer links when a tool call does not pass `baseUrl`. Must be `http` or `https`, no query/hash.
</ParamField>

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

<ParamField path="security.allowRemoteViewer" type="boolean" default="false">
  `false`: non-loopback requests to viewer routes are denied. `true`: remote viewers are allowed if tokenized path is valid.
</ParamField>

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

<AccordionGroup>
  <Accordion title="Viewer hardening">
    - Loopback-only by default.
    - Tokenized viewer paths with strict ID and token validation.
    - Viewer response CSP:
      - `default-src 'none'`
      - scripts and assets only from self
      - no outbound `connect-src`
    - Remote miss throttling when remote access is enabled:
      - 40 failures per 60 seconds
      - 60 second lockout (`429 Too Many Requests`)

  </Accordion>
  <Accordion title="File rendering hardening">
    - Screenshot browser request routing is deny-by-default.
    - Only local viewer assets from `http://127.0.0.1/plugins/diffs/assets/*` are allowed.
    - External network requests are blocked.

  </Accordion>
</AccordionGroup>

## Browser requirements for file mode

`mode: "file"` and `mode: "both"` need a Chromium-compatible browser.

Resolution order:

<Steps>
  <Step title="Config">
    `browser.executablePath` in OpenClaw config.
  </Step>
  <Step title="Environment variables">
    - `OPENCLAW_BROWSER_EXECUTABLE_PATH`
    - `BROWSER_EXECUTABLE_PATH`
    - `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`

  </Step>
  <Step title="Platform fallback">
    Platform command/path discovery fallback.
  </Step>
</Steps>

Common failure text:

- `Diff PNG/PDF rendering requires a Chromium-compatible browser...`

Fix by installing Chrome, Chromium, Edge, or Brave, or setting one of the executable path options above.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Input validation errors">
    - `Provide patch or both before and after text.` — include both `before` and `after`, or provide `patch`.
    - `Provide either patch or before/after input, not both.` — do not mix input modes.
    - `Invalid baseUrl: ...` — use `http(s)` origin with optional path, no query/hash.
    - `{field} exceeds maximum size (...)` — reduce payload size.
    - Large patch rejection — reduce patch file count or total lines.

  </Accordion>
  <Accordion title="Viewer accessibility">
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

  </Accordion>
  <Accordion title="Unmodified-lines row has no expand button">
    This can happen for patch input when the patch does not carry expandable context. This is expected and does not indicate a viewer failure.
  </Accordion>
  <Accordion title="Artifact not found">
    - Artifact expired due TTL.
    - Token or path changed.
    - Cleanup removed stale data.

  </Accordion>
</AccordionGroup>

## Operational guidance

- Prefer `mode: "view"` for local interactive reviews in canvas.
- Prefer `mode: "file"` for outbound chat channels that need an attachment.
- Keep `allowRemoteViewer` disabled unless your deployment requires remote viewer URLs.
- Set explicit short `ttlSeconds` for sensitive diffs.
- Avoid sending secrets in diff input when not required.
- If your channel compresses images aggressively (for example Telegram or WhatsApp), prefer PDF output (`fileFormat: "pdf"`).

<Note>
Diff rendering engine powered by [Diffs](https://diffs.com).
</Note>

## Related

- [Browser](/tools/browser)
- [Plugins](/tools/plugin)
- [Tools overview](/tools)
