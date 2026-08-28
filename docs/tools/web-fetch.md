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

`text`, `title`, and `warning` share `maxChars`, including their content wrappers.
Titles and warnings retain at most 256 characters each, with a combined wrapped
allowance of at most 512 characters and half of `maxChars`. Warnings take priority
over titles; unused metadata space stays available to the body. `truncated` is
also true when metadata is shortened or omitted; metadata-only truncation does
not create a body spill file.

JSON framing and protocol metadata are additional overhead. `contentType`,
`extractor`, and `fetchedAt` are capped at 256, 128, and 64 characters respectively.
URLs stay whole for follow-up requests: a returned redirect/provider URL longer
than 2,048 characters falls back to the requested `url` and marks the result
truncated. The caller's requested URL is preserved.

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

Set `tools.web.fetch.cacheTtlMinutes: 0` to bypass OpenClaw's fetch cache for both
reads and writes. A positive value limits reuse by the current request's TTL;
cached entries still expire at their original deadline. Provider-side caching,
such as Firecrawl's `maxAgeMs`, is configured separately.

## Progress updates

`web_fetch` emits a public progress line only when the fetch is still pending
after five seconds:

```text
Fetching page content...
```

Fast cache hits and quick network responses finish before the timer fires, so
they never show a progress line. Canceling the call clears the timer. The
progress line is channel UI state only and never contains fetched page content.

Cancellation also reaches the fallback provider. Already-canceled calls reject
even when a cached result exists. If cancellation occurs during fetching,
fallback processing, or connection cleanup, OpenClaw rejects the call instead
of returning success or adding a result to the fetch cache.

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
        headers: {
          // optional; every value is treated as sensitive
          "X-Routing-Target": "staging",
        },
        ssrfPolicy: {
          dangerouslyAllowPrivateNetwork: false, // broad private-network opt-in; keep false by default
          allowedHostnames: ["internal.example"], // narrow exact host exception
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

## Custom request headers

Set `tools.web.fetch.headers` when your deployment needs extra request metadata on
outbound fetches, such as a routing or service-injection header that steers traffic
to a gateway you control.

```json5
{
  tools: {
    web: {
      fetch: {
        headers: {
          "X-Routing-Target": "${WEB_FETCH_ROUTING_TARGET}",
        },
      },
    },
  },
}
```

<Warning>
  Every configured value is treated as sensitive and redacted from exposed config
  and debug captures. The headers are still sent to every initial URL `web_fetch`
  requests, and the model chooses that URL. Configure credential headers only when
  that is the intended trust boundary.
</Warning>

Behavior worth knowing:

- Values are plain strings and support `${VAR}` environment substitution like any
  other config string. Structured SecretRef values are not accepted.
- Headers apply only to the direct `web_fetch` request. Provider fallbacks such as
  [Firecrawl](/tools/firecrawl) call their own API and never receive these headers.
- Entries are validated when the request is built, not at config load, so one bad
  entry is dropped while the rest still apply. Config load stays permissive on
  purpose: a fail-closed validation error over a single header-name typo would
  disable the whole surface. Every dropped entry is logged by name.
- Dropped names:
  - `Accept`, `Accept-Language`, and `User-Agent` belong to the fetch and
    readability contract. Use `tools.web.fetch.userAgent` for the user agent.
  - Framing and hop-by-hop names such as `Content-Length`, `Transfer-Encoding`,
    `Connection`, and `Upgrade`, which a request either rejects outright or ignores.
  - Names that are not valid HTTP tokens, such as `"X Routing Target"`.
- Dropped values: bytes a request cannot carry (CR, LF, NUL, or any character above
  `U+00FF`). Missing environment variables are reported by config loading; the global
  `$${VAR}` escape remains available when the literal `${VAR}` text is intentional.
- Two entries whose names differ only in case collapse to the later entry, so a
  request never carries a comma-joined value the receiving gateway cannot parse.
  The dropped name is logged without either value. If the later entry is unusable,
  neither value is sent.
- Rejection happens before the cache key is computed, so the key always matches the
  bytes actually sent: changing a header that is really sent partitions the fetch
  cache, while adding one that gets dropped does not.
- When a redirect crosses origins, the guarded-fetch safe allowlist is applied.
  Routing headers outside that list are dropped; standard safe headers such as
  `Cache-Control`, `Content-Type`, and `Range` are preserved.

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
- `tools.web.fetch.ssrfPolicy.allowedHostnames` allows exact trusted hosts while leaving other private/internal targets blocked
- `tools.web.fetch.ssrfPolicy.dangerouslyAllowPrivateNetwork` broadly permits private-network targets; enable it only when model-selected URLs are trusted in this deployment
- `tools.web.fetch.ssrfPolicy.allowRfc2544BenchmarkRange` and
  `tools.web.fetch.ssrfPolicy.allowIpv6UniqueLocalRange` are narrow opt-ins
  for trusted fake-IP proxy stacks; leave them unset unless your proxy owns
  those synthetic ranges and enforces its own destination policy
- Redirects are checked and limited by `maxRedirects` (default `3`)
- `tools.web.fetch.headers` values are redacted from exposed config and debug
  captures, sent to the initial fetched host, and retained on redirects only when
  the existing guarded-fetch policy allows them
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
