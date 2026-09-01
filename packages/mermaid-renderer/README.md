# Shared Mermaid renderer

The Control UI and native chat use one pinned Mermaid engine, sandbox, and SVG
sanitizer. `renderMermaidSvg` renders in an opaque iframe and returns passive,
sanitized SVG. The host never inserts diagram-controlled HTML or grants the
iframe access to native bridges.

## Native assets

From the repository root:

```bash
pnpm install
pnpm --filter @openclaw/mermaid-renderer build
```

The build writes the offline document and scripts to
`apps/shared/mermaid/assets/mermaid/`. These generated assets stay out of Git.
Android's Gradle build runs this command automatically. Keep the directory
structure when packaging the assets; the host and iframe load relative scripts.

The local host exposes `window.renderMermaid` and sends JSON results through
`ChatMermaidBridge`. A successful result contains the sanitized SVG and the
dimensions of the decoded preview. Native hosts own queue admission, caching,
timeouts, bitmap capture, and process recovery. Only the trusted top-level
document receives the bridge; diagram input runs in the isolated child frame.

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
Android packages the original license texts per dependency in
`apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/`; the filename is the
Licenses screen's dependency title. Preserve the upstream copyright and license
text, including distinct license texts when Mermaid bundles multiple versions.
Do not replace these files with an aggregate notice bundle. When updating
Mermaid, audit its source map and retained license comments and refresh the
affected dependency files alongside the pinned dependency. Keep the existing
KaTeX notice when its MIT text matches, and preserve the separate JamaJS notice
for the Apache-licensed code embedded by layout-base.

Browser contract tests live in `ui/src/components/markdown-mermaid*.test.ts`.
They cover the sandbox, SVG sanitization, streaming presentation, native result
ordering, image decoding, and oversized-preview recovery.
