# Buzz Forum kind 45001 proof

This is the redacted local behavior proof for PR 138639.

## Environment

- Relay: `wss://buzz-powershiftintelligence.tech`
- Buzz room: `Engine Room (Down)` / `03404dd7-dffc-44f3-acdb-6d1fa8edb68f`
- Bot identity: `PowerShift Buzz Official` / `95751a...e83ab`
- OpenClaw route: `buzz:03404dd7-dffc-44f3-acdb-6d1fa8edb68f` -> `down`
- Activation pattern: `@Down\b`

## Before

- Human-authored Buzz Forum post was visible in Buzz desktop.
- Relay diagnostic identified the post as event kind `45001`.
- The installed Buzz plugin did not subscribe to `45001`, so the event never reached the configured allowlist, mention activation, binding, telemetry, or dead-letter path.

## After

After adding `45001` to the installed bundle's inbound message kind list and restarting the Gateway:

- Inbound event id: `8b3e9ed9724c90375e2b72423ca7dedd8a7b631680738650dd727d69ea4b3fb0`
- Inbound timestamp: `2026-09-04 15:51:13 CDT`
- Inbound text: `@Down Test from Engine Room (Down), Forum 2026-09.04`
- Down session key: `agent:down:buzz:group:buzz:03404dd7-dffc-44f3-acdb-6d1fa8edb68f`
- Assistant reply: `Received in Engine Room (Down): Forum 2026-09-04.`
- Buzz account telemetry after dispatch: `lastInboundAt=1788555726498`, `lastOutboundAt=1788555740214`
- Buzz dead letters: empty
- Gateway/Buzz health: ready, running, connected; `lastError=null`

## Verification commands

Local source validation for this PR:

- `pnpm exec vitest run extensions/buzz/src/buzz-bus.test.ts extensions/buzz/src/gateway.lifecycle.test.ts`
- `pnpm tsgo:extensions`
- `node_modules/.bin/oxlint --tsconfig extensions/tsconfig.json extensions/buzz/src/message-event.ts extensions/buzz/src/buzz-bus.ts extensions/buzz/src/gateway.ts extensions/buzz/src/buzz-bus.test.ts extensions/buzz/src/gateway.lifecycle.test.ts`
- `git diff --check`

The current PR body was also checked locally against
`scripts/github/real-behavior-proof-policy.mjs`; it passes the external PR
context/evidence section policy.

The relay signer stayed in local custody during diagnostics; no private key or secret material is present in this artifact.
