---
summary: "Read-only diff viewer and file renderer for agents (optional plugin tool)"
title: "Diffs"
sidebarTitle: "Diffs"
read_when:
  - You want agents to show code or markdown edits as diffs
  - You want a canvas-ready viewer URL or a rendered diff file
  - You need controlled, temporary diff artifacts with secure defaults
---

`diffs` is an optional bundled plugin tool that turns before/after text or a unified patch into a read-only diff artifact. It also prepends short agent guidance into the system prompt and ships a companion skill for fuller instructions.

Input: `before` + `after` text, or a unified `patch` (mutually exclusive).

Output: a gateway viewer URL for canvas presentation, a rendered PNG/PDF file path for message delivery, or both.

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
        Combined (default): agents call `diffs` with `mode: "both"` to get both artifacts in one call.
      </Tab>
    </Tabs>
  </Step>
</Steps>

## Disable built-in system guidance

To keep the tool but drop the prepended system-prompt guidance, set `plugins.entries.diffs.hooks.allowPromptInjection` to `false`:

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

This blocks the plugin's `before_prompt_build` hook while keeping the tool and skill available. To disable both guidance and the tool, disable the plugin instead.

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
  Display filename for before/after mode.
</ParamField>
<ParamField path="lang" type="string">
  Language override hint for before/after mode. Unknown values and languages outside the default viewer set fall back to plain text unless the
  Diff Viewer Language Pack plugin is installed.
</ParamField>
<ParamField path="title" type="string">
  Viewer title override.
</ParamField>
<ParamField path="mode" type='"view" | "file" | "both"'>
  Output mode. Defaults to plugin default `defaults.mode` (`both`). Deprecated alias: `"image"` behaves identically to `"file"`.
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
  Quality preset for PNG/PDF rendering.
</ParamField>
<ParamField path="fileScale" type="number">
  Device scale override (`1`-`4`).
</ParamField>
<ParamField path="fileMaxWidth" type="number">
  Max render width in CSS pixels (`640`-`2400`).
</ParamField>
<ParamField path="ttlSeconds" type="number" default="1800">
  Artifact TTL in seconds for viewer and standalone file outputs. Max `21600`.
</ParamField>
<ParamField path="baseUrl" type="string">
  Viewer URL origin override. Overrides plugin `viewerBaseUrl`. Must be `http` or `https`, no query/hash.
</ParamField>

<AccordionGroup>
  <Accordion title="Validation and limits">
    - `before`/`after`: max 512 KiB each.
    - `patch`: max 2 MiB.
    - `path`: max 2048 bytes.
    - `lang`: max 128 bytes.
    - `title`: max 1024 bytes.
    - Patch complexity cap: max 128 files and 120000 total lines.
    - `patch` together with `before`/`after` is rejected.
    - Rendered file safety limits (PNG and PDF):
      - `fileQuality: "standard"`: max 8 MP (8,000,000 rendered pixels).
      - `fileQuality: "hq"`: max 14 MP.
      - `fileQuality: "print"`: max 24 MP.
      - PDF also caps at 50 pages.

  </Accordion>
</AccordionGroup>

## Syntax highlighting

Built-in languages:

`javascript`, `typescript`, `tsx`, `jsx`, `json`, `markdown`, `yaml`, `css`, `html`, `sh`, `python`, `go`, `rust`, `java`, `c`, `cpp`, `csharp`, `php`, `sql`, `docker`, `ruby`, `swift`, `kotlin`, `r`, `dart`, `lua`, `powershell`, `xml`, and `toml`.

Common aliases (`js`, `ts`, `bash`, `md`, `yml`, `c++`, `dockerfile`, `rb`, `kt`, `ps1`, etc.) normalize to those languages.

Install the Diff Viewer Language Pack plugin for more languages (Astro, Vue, Svelte, MDX, GraphQL, Terraform/HCL, Nix, Clojure, Elixir, Haskell, OCaml, Scala, Zig, Solidity, Verilog/VHDL, Fortran, MATLAB, LaTeX, Mermaid, Sass/Less/SCSS, Nginx, Apache, CSV, dotenv, INI, diff, and more):

```bash
openclaw plugins install clawhub:@openclaw/diffs-language-pack
```

Without the pack, unsupported languages still render as readable plain text. See [Diffs Language Pack plugin](/plugins/reference/diffs-language-pack) and [Shiki languages](https://shiki.style/languages) for the upstream catalog.

## Output details contract

All successful results include `changed`: identical before/after input returns `false` without creating an artifact; rendered results return `true`.

<AccordionGroup>
  <Accordion title="Viewer fields (view and both modes)">
    - `changed`
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
  <Accordion title="File fields (file and both modes)">
    - `changed`
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
</AccordionGroup>

| Mode     | Returns                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- |
| `"view"` | Viewer fields only.                                                                             |
| `"file"` | File fields only, no viewer artifact.                                                           |
| `"both"` | Viewer fields plus file fields. If file rendering fails, viewer still returns with `fileError`. |

### Collapsed unchanged sections

The viewer shows rows like `N unmodified lines`. Expand controls only appear when the rendered diff has expandable context data (typical for before/after input). Many unified patches omit context bodies in their hunks, so the row can appear without an expand control -- expected, not a bug. `expandUnchanged` only applies when expandable context exists.

### Multi-file navigation

Patches that touch more than one file start with a changed-files summary card: total `+N` / `-N` counts, per-file counts, added/deleted/renamed badges, and anchor links that jump to each file. Rendered PNG/PDF files keep the per-file header counts but drop the interactive view toggles, since those are dead controls in a static file.

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
            ttlSeconds: 21600,
          },
        },
      },
    },
  },
}
```

Supported `defaults` keys: `fontFamily`, `fontSize`, `lineSpacing`, `layout`, `showLineNumbers`, `diffIndicators`, `wordWrap`, `background`, `theme`, `fileFormat`, `fileQuality`, `fileScale`, `fileMaxWidth`, `mode`, `ttlSeconds`. Explicit tool call parameters override these.

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
  `false`: non-loopback requests to viewer routes are denied. `true`: remote viewers are allowed if the tokenized path is valid.
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

- Artifacts live under `$TMPDIR/openclaw-diffs`.
- Viewer metadata stores a random 20-hex-char artifact ID, a random 48-hex-char token, `createdAt`/`expiresAt`, and the stored `viewer.html` path.
- Default artifact TTL: 30 minutes. Maximum accepted TTL: 6 hours.
- Cleanup runs opportunistically after each artifact create call; expired artifacts are deleted.
- Fallback sweep removes stale folders older than 24 hours when metadata is missing.

## Viewer URL and network behavior

Viewer route: `/plugins/diffs/view/{artifactId}/{token}`

Viewer assets:

- `/plugins/diffs/assets/viewer.js`
- `/plugins/diffs/assets/viewer-runtime.js`
- `/plugins/diffs-language-pack/assets/viewer.js` (only when the diff uses a language pack language)

The viewer document resolves these assets relative to the viewer URL, so an optional `baseUrl` path prefix carries through to asset requests too.

URL resolution order: tool-call `baseUrl` (after strict validation) -> plugin `viewerBaseUrl` -> loopback `127.0.0.1` default. If gateway bind mode is `custom` and `gateway.customBindHost` is set, that host is used instead of loopback.

`baseUrl` rules: must be `http://` or `https://`; query and hash are rejected; origin plus optional base path is allowed.

## Security model

<AccordionGroup>
  <Accordion title="Viewer hardening">
    - Loopback-only by default.
    - Tokenized viewer paths with strict ID and token pattern validation.
    - Viewer response CSP: `default-src 'none'`; scripts/assets only from self; no outbound `connect-src`.
    - Remote miss throttling when remote access is enabled: 40 failures per 60 seconds triggers a 60-second lockout (`429 Too Many Requests`).

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
    Common install paths and `PATH` lookups for Chrome, Chromium, Edge, and Brave.
  </Step>
</Steps>

Common failure text: `Diff PNG/PDF rendering requires a Chromium-compatible browser...`. Fix by installing Chrome, Chromium, Edge, or Brave, or setting one of the executable path options above.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Input validation errors">
    - `Provide patch or both before and after text.` -- include both `before` and `after`, or provide `patch`.
    - `Provide either patch or before/after input, not both.` -- do not mix input modes.
    - `Invalid baseUrl: ...` -- use an `http(s)` origin with optional path, no query/hash.
    - `{field} exceeds maximum size (...)` -- reduce payload size.
    - Large patch rejection -- reduce patch file count or total lines.

  </Accordion>
  <Accordion title="Viewer accessibility">
    - Viewer URL resolves to `127.0.0.1` by default.
    - For remote access, either set plugin `viewerBaseUrl`, pass `baseUrl` per call, or use `gateway.bind=custom` with `gateway.customBindHost`.
    - If `gateway.trustedProxies` includes loopback for a same-host proxy (for example Tailscale Serve), raw loopback viewer requests without forwarded client-IP headers fail closed by design.
    - For that proxy topology, prefer `mode: "file"`/`"both"` for an attachment, or intentionally enable `security.allowRemoteViewer` plus plugin `viewerBaseUrl`/a proxy `baseUrl` for a shareable viewer link.
    - Enable `security.allowRemoteViewer` only when external viewer access is intended.

  </Accordion>
  <Accordion title="Unmodified-lines row has no expand button">
    Expected for patch input that lacks expandable context; not a viewer failure.
  </Accordion>
  <Accordion title="Artifact not found">
    - Artifact expired due to TTL.
    - Token or path changed.
    - Cleanup removed stale data.

  </Accordion>
</AccordionGroup>

## Operational guidance

- Prefer `mode: "view"` for local interactive reviews in canvas.
- Prefer `mode: "file"` for outbound chat channels that need an attachment.
- Keep `allowRemoteViewer` disabled unless your deployment requires remote viewer URLs.
- Set an explicit short `ttlSeconds` for sensitive diffs.
- Avoid sending secrets in diff input when not required.
- If your channel compresses images aggressively (for example Telegram or WhatsApp), prefer PDF output (`fileFormat: "pdf"`).

<Note>
Diff rendering engine powered by [Diffs](https://diffs.com).
</Note>

## Related

- [Browser](/tools/browser)
- [Plugins](/tools/plugin)
- [Tools overview](/tools)
