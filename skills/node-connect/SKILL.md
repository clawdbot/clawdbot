---
name: node-connect
description: "Diagnose OpenClaw Control UI browser and native Android, iOS, or macOS node connection failures across route, auth, pairing, QR/setup-code, and reconnect states."
---

# Node Connect

Goal: fix one exact client against one exact Gateway, then prove that client's fresh connection.

## 1. Lock the target

Record the target environment/profile, OpenClaw binary, config/state root, Gateway URL/port, and service before changing anything.

- Use the named deployment wrapper/profile for every config, log, service, device, and node command.
- Never drift to a bare `openclaw`, proof environment, or similarly named deployment.
- If the global executable is stale, invoke the target through its owner.
- Verify status, config, logs, and process identity describe the same Gateway.

Do not mutate pairing or auth until the target is unambiguous.

## 2. Classify the client

Classify from the request and Gateway log before choosing commands:

- **Control UI browser:** the user says browser, dashboard, Control UI, or webchat; logs show `client=openclaw-control-ui` or `mode=webchat`.
- **Native mobile/node:** the official app shows Connect, Scan QR, or setup code; logs/request metadata show a native client or `role=node`.

A phone can be either client. Do not use `openclaw qr` or `openclaw nodes status` for a phone browser; those belong to native mobile/node pairing.

## 3. Observe the failing attempt

Run these through the locked target:

```bash
openclaw gateway status --deep
openclaw logs --follow --json
openclaw devices list
openclaw config get gateway.mode
openclaw config get gateway.bind
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
openclaw config get gateway.auth.allowTailscale
openclaw config get gateway.tailscale.mode
```

Have the client retry once while logs are live. Correlate its client ID, mode, platform, address, auth result, device ID, user, and close code. Ignore other paired devices.

Interpret the first failed transition:

- No matching Gateway attempt: route, DNS, TLS, origin, or proxy problem.
- `token_missing`, `password_missing`, mismatch, or Tailscale identity failure: auth failed **before** pairing, so an empty pending list is expected.
- `pairing required`: route and auth succeeded; approve the exact pending request.
- `authenticated user connected` / `webchat connected`: match the exact client; if followed by `1006`, preserve auth/pairing and inspect lifecycle, transport, proxy, or reconnect.
- `1006` without either application-level connected log does not prove auth/pairing; inspect the earlier handshake transition.

## 4. Prove the route

Choose one topology: same machine, LAN, tailnet, or public reverse proxy. Do not mix them.

- Browser Control UI needs HTTPS or localhost for browser device identity. A remote plain-HTTP Tailnet/LAN URL is not a valid substitute.
- `gateway.tailscale.mode=off` means OpenClaw is not managing Serve/Funnel. It does not prove that Tailscale or an externally managed Serve route is absent.
- When Tailscale is involved, inspect live state rather than inferring it from OpenClaw config:

```bash
tailscale status --json
tailscale serve status --json
```

Match the client's URL to the listener/proxy route reaching the locked Gateway.

## 5A. Control UI browser lane

Restore browser auth before looking for a pairing request:

- For token/password auth, enter the credential in Control UI settings. Never put permanent secrets in chat, logs, or URLs.
- Prefer `openclaw dashboard` on the Gateway host for a one-time signed handoff. Use `--no-open` only when the operator can retrieve that host's clipboard, and keep the host browser/clipboard outside agent tooling. Never capture `dashboard --json`: it can expose the handoff and shared credentials. Never relay, rewrite, or send a loopback handoff URL to a remote phone.
- For Tailscale Serve, verify the live route and forwarded identity. Enable `gateway.auth.allowTailscale` only for that intended trust boundary. Verified Tailscale Control UI auth with browser device identity can skip pairing.

After auth succeeds:

- Retry; never infer pairing from the pre-auth attempt. Token/password auth can reveal `pairing required`; verified Tailscale identity can skip it.
- If logs say `pairing required`, re-list devices and approve the exact request ID.
- A successful verified-Tailscale connection may correctly create no pending or paired-device row.
- After a repeated `1006`, preserve auth/pairing and inspect reconnect evidence.

## 5B. Native mobile/node lane

Inspect the native route through the locked target without exposing the setup credential:

```bash
openclaw qr --json | jq '{gatewayUrl, gatewayUrls, auth, access, accessDowngraded, urlSource}'
```

For a CLI controlling a remote Gateway, add `--remote` before `--json`; it selects `gateway.remote.url` and remote credentials. If the redaction filter is unavailable, do not run raw QR JSON in agent-visible output.

Verify `gatewayUrl` and `urlSource`. The setup code is password-equivalent: have the operator copy it from **Control UI → Devices → Pair device**, or run `openclaw qr --setup-code-only` in a terminal outside agent tooling and paste it directly into the official app. Never relay it through agent/chat/tool output. Generate a fresh code after a URL/auth fix or expiry.

If the app reports `pairing required`:

```bash
openclaw devices list
openclaw devices approve --latest   # preview only; exits without approval
openclaw devices approve <requestId>
openclaw nodes status
```

`--latest` only previews the current request; never treat it as approval. Re-list immediately before the exact-ID command because retries can supersede the request. Never approve by position, age, or similarity.

## 6. Correlate and finish

Before approval, match available request, device/public-key, client, mode/role, platform, address, user, and retry-time facts.

Declare success only after a new attempt made after the final change proves all applicable checks:

- the exact client reaches the locked Gateway;
- intended auth succeeds;
- the browser completes initial requests, or the native node appears in `openclaw nodes status`;
- approval used the exact request ID; and
- no immediate auth, pairing, or reconnect failure follows.

A QR/setup code, launched browser, empty pending list, approval, paired-device count, or Tailscale ping proves only one transition.

Report the diagnosis, chosen route/auth lane, exact-client evidence, and any remaining failed transition.
