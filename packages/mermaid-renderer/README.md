# Shared Mermaid renderer

The Control UI and native chat use one pinned Mermaid engine, sandbox, and SVG
sanitizer. `renderMermaidSvg` renders in an opaque iframe and returns passive,
sanitized SVG. The host never inserts diagram-controlled HTML and accepts native
results only from its trusted top-level document.

## Native assets

From the repository root:

```bash
pnpm install
pnpm --dir packages/mermaid-renderer build
```

The build writes the offline document and scripts to
`apps/shared/mermaid/assets/mermaid/`. These generated assets stay out of Git.
Android's Gradle build runs this command automatically. Keep the directory
structure when packaging the assets; the host and iframe load relative scripts.

Apple builds run `node scripts/prepare-apple-mermaid.mjs` before SwiftPM opens the
package graph. The helper builds the same assets and copies them into the shared
ChatUI resource bundle. iOS project generation and the macOS build entry points
run it automatically; direct SwiftPM invocations must run it first.

The local host exposes `window.renderMermaid` and sends JSON results through
`ChatMermaidBridge`. A successful result contains the sanitized SVG and the
dimensions of the decoded preview. Native hosts own queue admission, caching,
timeouts, bitmap capture, and process recovery. WebKit exposes named handlers to
all frames, so Apple hosts validate the current WebView, main frame, exact
document URL, and active job before accepting a result. Diagram input runs in
the isolated child frame.

The renderer limits source to 20,000 UTF-16 code units, edges to 200, SVG output
to 1,000,000 code units and 5,000 elements, and native preview area to 4,194,304
CSS pixels. The render watchdog is 15 seconds; the native host must replace an
unresponsive WebView because a JavaScript timer cannot interrupt synchronous
layout. Raster decoding has a separate five-second watchdog. Failed renders
leave source available in the caller's UI.

## Dependency notices

Mermaid's classic bundle includes dependencies with versions different from the
workspace's installed packages. Native notices must cover the exact bundle,
including its embedded DOMPurify, as well as the host's DOMPurify dependency.
Android and iOS package the original license texts per dependency in
`apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/` and
`apps/ios/Resources/Licenses/`; the filename is the Licenses screen's dependency
title. The generated assets also carry `native/NOTICE.txt` for the shared Apple
resource bundle. Preserve the upstream copyright and license
text, including distinct license texts when Mermaid bundles multiple versions.
Do not replace these files with an aggregate notice bundle. When updating
Mermaid, audit its source map and retained license comments and refresh the
affected dependency files alongside the pinned dependency. Keep the existing
KaTeX notice when its MIT text matches, and preserve the separate JamaJS notice
for the Apache-licensed code embedded by layout-base.

Browser contract tests live in `ui/src/components/markdown-mermaid*.test.ts`.
They cover the sandbox, SVG sanitization, streaming presentation, native result
ordering, image decoding, and oversized-preview recovery.
