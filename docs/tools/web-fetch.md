---
summary: "web_fetch tool -- HTTP fetch with readable content extraction"
read_when:
  - You want to fetch a URL and extract readable content
  - You need to configure web_fetch or its Firecrawl fallback
  - You want to understand web_fetch limits and caching
title: "Web fetch"
sidebarTitle: "Web Fetch"
---

`web_fetch` does a plain HTTP GET and extracts readable content (HTML to
markdown or text). It does **not** execute JavaScript. For JS-heavy sites or
login-protected pages, use the [Web Browser](/tools/browser) instead.

## Quick start

Enabled by default, no configuration needed:

```javascript
await web_fetch({ url: "https://example.com/article" });
```

## Tool parameters

<ParamField path="url" type="string" required>
URL to fetch. `http(s)` only.
</ParamField>

<ParamField path="extractMode" type="'markdown' | 'text'" default="markdown">
Output format after main-content extraction.
</ParamField>

<ParamField path="maxChars" type="number">
Truncate output to this many characters. Clamped to `tools.web.fetch.maxCharsCap`.
</ParamField>

## Result

`web_fetch` returns a closed structured result with these fields:

- Request metadata: `url`, `finalUrl`, `status`, `extractMode`, and `extractor`
- Optional response metadata: `contentType`, `title`, and `warning` (omitted when absent)
- Wrapped content metadata: `externalContent`, `truncated`, `length`, `rawLength`,
  `fetchedAt`, `tookMs`, and `text`
- Optional `cached: true` on a cache hit
- Optional `spill: { path, chars, truncated? }` when truncated content was written
  to a private temporary file; `truncated` is present only when that file contains
  partial source content

`length` is the wrapped `text` length. `rawLength` is the extracted content length
before external-content wrapping.

## How it works

<Steps>
  <Step title="Fetch">
    Sends an HTTP GET with a Chrome-like User-Agent and `Accept-Language`
    header. Blocks private/internal hostnames and re-checks redirects.
  </Step>
  <Step title="Extract">
    Runs Readability (main-content extraction) on the HTML response.
  </Step>
  <Step title="Fallback (optional)">
    If Readability fails and a fetch provider is available, retries through
    that provider (for example Firecrawl's bot-circumvention mode).
  </Step>
  <Step title="Cache">
    Results are cached for 15 minutes (configurable) to reduce repeated
    fetches of the same URL.
  </Step>
</Steps>

## Progress updates

`web_fetch` emits a public progress line only when the fetch is still pending
after five seconds:

```text
Fetching page content...
```

Fast cache hits and quick network responses finish before the timer fires, so
they never show a progress line. Canceling the call clears the timer. The
progress line is channel UI state only and never contains fetched page content.

## Config

```json5
{
  tools: {
    web: {
      fetch: {
        enabled: true, // default: true
        provider: "firecrawl", // optional; omit for auto-detect
        maxChars: 20000, // default output chars; capped by maxCharsCap
        maxCharsCap: 20000, // hard cap for maxChars param
        maxResponseBytes: 750000, // max download size before truncation (32000-10000000)
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        useTrustedEnvProxy: false, // let a trusted HTTP(S) env proxy resolve DNS
        readability: true, // use Readability extraction
        userAgent: "Mozilla/5.0 ...", // override User-Agent
        ssrfPolicy: {
          allowRfc2544BenchmarkRange: true, // opt-in for trusted fake-IP proxies using 198.18.0.0/15
          allowIpv6UniqueLocalRange: true, // opt-in for trusted fake-IP proxies using fc00::/7
        },
      },
    },
  },
}
```

## Firecrawl fallback

If Readability extraction fails, `web_fetch` can fall back to
[Firecrawl](/tools/firecrawl) for bot-circumvention and better extraction:

```json5
{
  tools: {
    web: {
      fetch: {
        provider: "firecrawl", // optional; omit for auto-detect from available credentials
      },
    },
  },
  plugins: {
    entries: {
      firecrawl: {
        enabled: true,
        config: {
          webFetch: {
            // apiKey: "fc-...", // optional; omit for keyless starter access
            baseUrl: "https://api.firecrawl.dev",
            onlyMainContent: true,
            maxAgeMs: 172800000, // cache duration (2 days)
            timeoutSeconds: 60,
          },
        },
      },
    },
  },
}
```

`plugins.entries.firecrawl.config.webFetch.apiKey` is optional and supports SecretRef objects.
Legacy `tools.web.fetch.firecrawl.*` config auto-migrates to
`plugins.entries.firecrawl.config.webFetch` via `openclaw doctor --fix`.

<Note>
  If you configure a Firecrawl API-key SecretRef and it is unresolved with no
  `FIRECRAWL_API_KEY` env fallback, gateway startup fails fast.
</Note>

<Note>
  Firecrawl `baseUrl` overrides are locked down: hosted traffic uses
  `https://api.firecrawl.dev`; self-hosted overrides must target private or
  internal endpoints, and `http://` is accepted only for those private targets.
</Note>

Current runtime behavior:

- `tools.web.fetch.provider` selects the fetch fallback provider explicitly.
- If `provider` is omitted, OpenClaw auto-detects the first ready web-fetch
  provider from configured credentials. Non-sandboxed `web_fetch` can use
  installed plugins that declare `contracts.webFetchProviders` and register a
  matching provider at runtime. The official Firecrawl plugin provides this
  fallback today.
- Sandboxed `web_fetch` calls allow bundled providers plus installed providers
  whose official npm or ClawHub provenance is verified. Today that permits the
  official Firecrawl plugin; third-party external fetch plugins stay excluded.
- If Readability is disabled, `web_fetch` skips straight to the selected
  provider fallback. If no provider is available, it fails closed.

## Trusted env proxy

If your deployment requires `web_fetch` to go through a trusted outbound
HTTP(S) proxy, set `tools.web.fetch.useTrustedEnvProxy: true`.

In this mode, OpenClaw still applies hostname-based SSRF checks before sending
the request, but it lets the proxy resolve DNS instead of doing local DNS
pinning. Enable this only when the proxy is operator-controlled and enforces
outbound policy after DNS resolution.

<Note>
  If no HTTP(S) proxy env var is configured, or the target host is excluded by
  `NO_PROXY`, `web_fetch` falls back to the normal strict path with local DNS
  pinning.
</Note>

## Limits and safety

- `maxChars` is clamped to `tools.web.fetch.maxCharsCap` (default `20000`)
- Response body is capped at `maxResponseBytes` (default `750000`, clamped to
  32000-10000000) before parsing; oversized responses are truncated with a warning
- Private/internal hostnames are blocked
- `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange` and
  `tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange` are narrow opt-ins
  for trusted fake-IP proxy stacks; leave them unset unless your proxy owns
  those synthetic ranges and enforces its own destination policy
- Redirects are checked and limited by `maxRedirects` (default `3`)
- `useTrustedEnvProxy` is an explicit opt-in and should only be enabled for
  operator-controlled proxies that still enforce outbound policy after DNS
  resolution
- `web_fetch` is best-effort -- some sites need the [Web Browser](/tools/browser)

## Tool profiles

If you use tool profiles or allowlists, add `web_fetch` or `group:web`:

```json5
{
  tools: {
    allow: ["web_fetch"],
    // or: allow: ["group:web"]  (includes web_fetch, web_search, and x_search)
  },
}
```

## Related

- [Web Search](/tools/web) -- search the web with multiple providers
- [Web Browser](/tools/browser) -- full browser automation for JS-heavy sites
- [Firecrawl](/tools/firecrawl) -- Firecrawl search and scrape tools
