---
summary: "What giving the model a real browser exposes, and the SSRF policy that bounds it"
read_when:
  - Enabling browser control or the Chrome extension relay
  - Deciding which browser profile an agent may drive
  - Tuning the browser SSRF allow and block lists
title: "Browser control risks"
sidebarTitle: "Browser control"
---

## Browser control risks

Enabling browser control gives the model a real browser. If that profile already has logged-in sessions, the model can access those accounts and data - treat browser profiles as sensitive state.

- Prefer a dedicated profile for the agent (the default `openclaw` profile); avoid your personal daily-driver profile.
- Keep host browser control disabled for sandboxed agents unless you trust them.
- The standalone loopback browser control API only honors shared-secret auth (gateway token bearer auth or gateway password) - it does not consume trusted-proxy or Tailscale Serve identity headers.
- Treat browser downloads as untrusted input; prefer an isolated downloads directory.
- Disable browser sync/password managers in the agent profile if possible.
- For remote gateways, "browser control" is equivalent to "operator access" to whatever that profile can reach.
- Keep Gateway and node hosts tailnet-only; avoid exposing browser control ports to LAN or public internet.
- Disable browser proxy routing when not needed (`gateway.nodes.browser.mode="off"`).
- Chrome MCP existing-session mode is not "safer" - it can act as you in whatever that host Chrome profile can reach.
- Browser Relay Authentication v2 never sends the persistent extension relay
  key. The extension and external CDP clients verify a signed server challenge
  before returning a short-lived, one-time, connection-bound HMAC proof. Proofs
  bind the protocol version, role, transport, method, resource, flow, profile,
  and relay instance; replay on the same or another socket fails.
- `browser.extensionRelay.allowLegacyAuth` defaults to `true` for one migration
  window. This temporarily accepts old Bearer, Basic, and token-subprotocol
  relay clients. Update every relay client, then set it to `false`. V2 clients
  never downgrade after a failed proof or unsupported response.
- Chrome extension pairing stores its access mode in extension-owned Chrome
  storage, not Gateway config. **All tabs** exposes every eligible ordinary tab
  in that Chrome profile except session-paused tabs; **Selected tabs** uses the
  OpenClaw tab group as its ACL. Existing pairings migrate to **Selected tabs**,
  while new personal-browser pairings recommend **All tabs**. Incognito and
  internal Chrome pages remain excluded in either mode.
- Automatic Chrome extension setup uses an origin-locked native messaging
  manifest discovered from an exact unpacked extension path in Chrome profile
  metadata. The one-shot host accepts only a versioned request with a fresh
  nonce, caps input at 4 KiB, validates the Chrome-supplied origin, and returns
  only a locally owned pairing. It never transfers a remote Gateway key.
- Native-host manifests, launchers, and status output contain no pairing key.
  OpenClaw refuses symlinks, unsafe ownership/modes, wildcard origins, and
  foreign registrations using the same host name. Windows uses the manual
  pairing fallback until an executable native-host path is supported.
- Run a **node host** on the browser machine and let the Gateway proxy browser actions when the Gateway is remote from the browser (see [Browser tool](/tools/browser)); treat node pairing like admin access, keep Gateway and node host on the same tailnet, and avoid exposing relay/control ports over LAN, public internet, or Tailscale Funnel.

### Browser SSRF policy (strict by default)

Private/internal destinations stay blocked unless you explicitly opt in.

- Default: `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork` unset, so private/internal/special-use destinations stay blocked. Legacy alias `allowPrivateNetwork` still accepted.
- Opt-in: set `dangerouslyAllowPrivateNetwork: true` to allow those destinations.
- `browser.ssrfPolicy.blockedHostnames` denies exact hosts and wildcard subdomains before DNS and any allow rule, including private-network exceptions. `*.example.com` does not block the apex `example.com`; add both to block the entire domain. An empty or absent list adds no denials. `tools.web.fetch.ssrfPolicy.blockedHostnames` provides the same policy for guarded fetches, including redirects.
- In strict mode, use wildcard-aware `allowedHostnames` entries for patterns like `*.example.com` and exact host exceptions, including otherwise-blocked names like `localhost`.
- Direct navigation requests are preflight checked. During the action and bounded post-action grace, guarded Playwright interactions (click, coordinate click, hover, drag, scroll, select, press, type, form fill, and evaluate) intercept policy-denied top-level and subframe document loads before HTTP request bytes, then best-effort re-check the final `http(s)` URL.
- Before each fresh managed Chrome launch, OpenClaw best-effort disables network prediction, suppressing Chromium's observed speculative preconnect for those denied loads. This is defense in depth, not a policy boundary: a browser reused across a control-service restart and other browser backends may not share the hardening. Page routing remains request-level interception, not a network firewall: redirect hops, a popup's first request, Service Worker traffic, page code that runs after the bounded guard window, and some background/subresource paths can bypass it. Final-URL checks remain detection/quarantine defense; complete prevention requires owner-side egress isolation or a policy-enforcing proxy.

```json5
{
  browser: {
    ssrfPolicy: {
      dangerouslyAllowPrivateNetwork: false,
      allowedHostnames: ["*.example.com", "example.com", "localhost"],
    },
  },
}
```
