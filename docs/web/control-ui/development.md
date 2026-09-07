---
summary: "Build the Control UI, run the dev server, and point it at a remote Gateway"
read_when:
  - Building or serving the Control UI yourself
  - Running the Vite dev server against a remote Gateway
title: "Build and develop"
sidebarTitle: "Build and develop"
---

Contributor notes for building the Control UI and running it against a Gateway you choose.

## Build and develop the UI

The Gateway serves static files from `dist/control-ui`:

```bash
pnpm ui:build
```

For bundled builds, the Gateway retains manifest-verified assets so already-open tabs can fetch older asset URLs after an update. The cache keeps at most three generations and 96 MiB total, preferring the current generation; older generations can be pruned sooner to meet the byte budget. Background startup preparation reuses verified inventories through publication and pruning instead of rereading unchanged retained assets at each step. Newly published assets are verified before reuse, including a concurrent publisher's winning copy. Configured `gateway.controlUi.root` builds do not use this cache.

Bundled public assets (themes, fonts, icons, and artwork) use `?v=<build-id>` URLs with a one-year immutable HTTP cache. The ID includes a digest of the public files, so rebuilding changed files at the same commit also changes their URLs. The Gateway snapshots this identity at startup; restart it after rebuilding an in-place installation. Unversioned requests, stale IDs, documents, `sw.js`, and custom `gateway.controlUi.root` installs keep `Cache-Control: no-cache`. The service worker keeps its network-first policy for public assets, allowing the browser's HTTP cache to satisfy matching versioned requests.

Non-index static assets use `Last-Modified` for conditional `GET` and `HEAD` requests. `If-None-Match` takes precedence over `If-Modified-Since`: `*` matches an existing asset, while other values receive the normal `200` response because static assets do not emit ETags. Date-only revalidation still returns `304` for unchanged assets. If no available content encoding is acceptable, the Gateway returns `406` before evaluating either condition.

All three HTTP-date formats are interpreted as UTC. Invalid or repeated `If-Modified-Since` fields are ignored, so they cannot suppress the current asset bytes. A leap-second validator remains earlier than the following second.

Static asset URLs support percent-encoded filenames. Contained symlinks retain the requested asset's MIME type, and a symlinked `index.html` receives the same base-path and document preparation as other entry routes.

Optional absolute base (fixed asset URLs):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Local development (separate dev server):

```bash
pnpm ui:dev
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).

For a standalone preview with synthetic data, use:

```bash
pnpm dev:ui:mock -- --port 19321
```

Open the printed URL in a fresh Chromium profile or isolated browser context,
without existing service workers or operator credentials. Chat, presence, and
profile data are synthetic. Add `--fixture attachments` for media examples; the
printed board fixture URL is also available.

The mock preview selects its own origin for Gateway resources, including
avatars, before application startup. It supplies synthetic WebSocket responses
and confines native resource requests to the serving origin and local data/blob
fixtures, including frames, while preserving same-origin Vite HMR and terminal
WebAssembly. Unimplemented HTTP API routes return a local JSON 404; external
fetches are rejected with a standalone-mock diagnostic. New workers, Talk WebRTC,
popups, and external link/navigation actions are disabled in the mock app.
External iframe URL assignments are rejected before Chromium can speculatively
connect. Add a local fixture when a demo needs another response. Each invocation
owns a separate Vite cache and removes it on graceful shutdown, so concurrent
previews and attachment fixtures do not invalidate one another.

This is a trusted-fixture development boundary, not a sandbox for hostile HTML,
browser extensions, or an already-controlling service worker. Browser-level
navigation outside the app is outside its control. Production connection settings
and `pnpm ui:dev` behavior are unchanged; use that command when you intentionally
need a real Gateway or external integration.

## Debugging/testing: dev server + remote Gateway

The Control UI is static files; the WebSocket target is configurable and can differ from the HTTP origin. This is handy when you want the Vite dev server locally but the Gateway runs elsewhere.

<Steps>
  <Step title="Start the UI dev server">
    ```bash
    pnpm ui:dev
    ```
  </Step>
  <Step title="Connect the remote Gateway">
    Follow the [remote Gateway URL handoff](/web/urls#remote-gateway-handoff)
    reference for the encoded Gateway URL and optional one-time credentials.
  </Step>
</Steps>

<AccordionGroup>
  <Accordion title="Origin security notes">
    - Public non-loopback Control UI deployments must set `gateway.controlUi.allowedOrigins` explicitly (full origins). Private same-origin LAN/Tailnet loads from loopback, RFC1918/link-local, `.local`, `.ts.net`, or Tailscale CGNAT hosts are accepted without enabling Host-header fallback.
    - Gateway startup may seed local origins such as `http://localhost:<port>` and `http://127.0.0.1:<port>` from the effective runtime bind and port, but remote browser origins still need explicit entries.
    - Do not use `gateway.controlUi.allowedOrigins: ["*"]` except for tightly controlled local testing; it means allow any browser origin, not "match whatever host I am using."
    - `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables Host-header origin fallback mode, but it is a dangerous security mode.

  </Accordion>
</AccordionGroup>

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Remote access setup details: [Remote access](/gateway/remote).
