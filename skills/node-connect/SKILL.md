---
name: node-connect
description: "Diagnose OpenClaw Control UI browser and native Android, iOS, or macOS node connection failures across route, auth, pairing, QR/setup-code, and reconnect states."
---

# Node Connect

Goal: fix one exact client against one exact Gateway, then prove that client's fresh connection.

## 1. Lock the target

Record the target environment/profile, OpenClaw binary, config/state root, Gateway URL/port, and service before changing anything.

- If the operator names a deployment wrapper or profile, use it for every config, log, service, device, and node command.
- Never fall back to a bare `openclaw`, a proof environment, or a similarly named deployment after the target is known.
- If the global executable is stale or broken, invoke the target through its owner instead of switching installations.
- Verify that status, config, logs, and process identity all describe the same Gateway.

Do not mutate pairing or auth until the target is unambiguous.

## 2. Classify the client

Classify from the user's words and the Gateway's connection log before choosing commands:

- **Control UI browser:** the user says browser, dashboard, Control UI, or webchat; logs show `client=openclaw-control-ui` or `mode=webchat`.
- **Native mobile/node:** the official app shows Connect, Scan QR, or setup code; logs/request metadata show a native client or `role=node`.

A phone can be either client. Do not use `openclaw qr` or `openclaw nodes status` for a phone browser; those belong to native mobile/node pairing.

## 3. Observe the failing attempt

Run these through the locked target:

```bash
openclaw gateway status --deep
openclaw logs --follow --json
openclaw devices list
openclaw config get gateway.bind
openclaw config get gateway.auth.mode
openclaw config get gateway.auth.allowTailscale
openclaw config get gateway.tailscale.mode
```

Have the client retry once while logs are live. Capture client ID, mode, platform, remote/forwarded address, auth reason or method, device ID, authenticated user, and close code. Correlate those facts to the failing client; a different paired device is not evidence about this one.

Interpret the first failed transition:

- No matching Gateway attempt: route, DNS, TLS, origin, or proxy problem.
- `token_missing`, `password_missing`, mismatch, or Tailscale identity failure: auth failed **before** pairing, so an empty pending list is expected.
- `pairing required`: route and auth succeeded; approve the exact pending request.
- Successful connect followed by close `1006`: auth/pairing succeeded; diagnose browser lifecycle, transport, proxy, or reconnect instead of pairing again.
- `authenticated user connected` / `webchat connected`: identify the auth method and exact client before declaring success.

## 4. Prove the route

Choose one intended topology: same machine, same LAN, same tailnet, or public reverse proxy. Do not mix routes while diagnosing.

- Browser Control UI needs HTTPS or localhost for browser device identity. A remote plain-HTTP Tailnet/LAN URL is not a valid substitute.
- `gateway.tailscale.mode=off` means OpenClaw is not managing Serve/Funnel. It does not prove that Tailscale or an externally managed Serve route is absent.
- When Tailscale is involved, inspect live state rather than inferring it from OpenClaw config:

```bash
tailscale status --json
tailscale serve status --json
```

Match the URL the client opened to the listener/proxy route that reached the locked Gateway.

## 5A. Control UI browser lane

Restore browser auth before looking for a pairing request:

- For token/password auth, enter the credential in Control UI settings. Never paste a permanent secret into chat, logs, or a public URL.
- On the Gateway host, `openclaw dashboard` is the preferred one-time signed browser handoff. `openclaw dashboard --json` exposes a short-lived `browserUrl`; treat it as a secret and use it only when its host is reachable by the intended browser. Never send a loopback `browserUrl` to a remote phone or rewrite its origin.
- For an intended Tailscale Serve flow, verify the live Serve route and forwarded Tailscale identity. Enable `gateway.auth.allowTailscale` only when the operator intends that trust boundary. A verified Tailscale Control UI connection with browser device identity can authenticate without a pending pairing request.

After auth succeeds:

- Retry and interpret the new state; never infer the pairing outcome from the pre-auth attempt. Token/password auth can reveal `pairing required`, while verified Tailscale identity can skip that round trip.
- If logs say `pairing required`, re-list devices and approve the exact request ID.
- If verified Tailscale identity connects successfully, no pending request and no new paired-device row can be correct.
- If the browser connects and then repeats `1006`, keep the auth/pairing state and move to reconnect evidence.

## 5B. Native mobile/node lane

Generate the native app's setup payload through the locked target:

```bash
openclaw qr --json
```

Use `gatewayUrl` and `urlSource` to verify the advertised route. If the user cannot scan, copy the short-lived setup code into the official app's manual setup flow. Generate a fresh code after any URL/auth fix or expiry.

If the app reports `pairing required`:

```bash
openclaw devices list
openclaw devices approve --latest   # preview only; copy the requestId
openclaw devices approve <requestId>
openclaw nodes status
```

Re-list immediately before approval because a retry can supersede the pending request. Never approve by position, age alone, or similarity to another device.

## 6. Correlate and finish

Before any approval, match as many authoritative facts as available: request ID, device ID/public key, client ID, mode/role, platform, remote address, authenticated user, and retry time.

Declare success only after a new attempt made after the final change proves all applicable checks:

- the exact client reaches the locked Gateway;
- auth succeeds with the intended method/user;
- the browser shows connected and completes its initial Gateway requests, or the native node appears connected in `openclaw nodes status`;
- any required approval used the exact request ID;
- no immediate repeated auth, pairing, or reconnect failure follows.

A generated QR/setup code, launched browser, empty pending list, approval response, paired device count, or successful Tailscale ping is evidence for one transition only. None alone proves the client is connected.

Report one concrete diagnosis, the one route/auth lane used, the exact client evidence, and the remaining failure transition if connection is still incomplete.
