---
summary: "Synthetic Slack-class channel plugin for deterministic OpenClaw QA scenarios"
title: "QA channel"
read_when:
  - You are wiring the synthetic QA transport into a local or CI test run
  - You need the bundled qa-channel config surface
  - You are iterating on end-to-end QA automation
---

`qa-channel` is a bundled synthetic message transport for automated OpenClaw QA.

It is not a production channel. It exists to exercise the same channel plugin
boundary used by real transports while keeping state deterministic and fully
inspectable.

## What it does today

- Slack-class target grammar:
  - `dm:<user>`
  - `channel:<room>`
  - `thread:<room>/<thread>`
- HTTP-backed synthetic bus for:
  - inbound message injection
  - outbound transcript capture
  - thread creation
  - reactions
  - edits
  - deletes
  - search and read actions
- Bundled host-side self-check runner that writes a Markdown report

## Config

```json
{
  "channels": {
    "qa-channel": {
      "baseUrl": "http://127.0.0.1:43123",
      "botUserId": "openclaw",
      "botDisplayName": "OpenClaw QA",
      "allowFrom": ["*"],
      "pollTimeoutMs": 1000
    }
  }
}
```

Supported account keys:

- `baseUrl`
- `botUserId`
- `botDisplayName`
- `pollTimeoutMs`
- `allowFrom`
- `defaultTo`
- `actions.messages`
- `actions.reactions`
- `actions.search`
- `actions.threads`

## Runner

Current vertical slice:

```bash
pnpm qa:e2e
```

This now routes through the bundled `qa-lab` extension. It starts the in-repo
QA bus, boots the bundled `qa-channel` runtime slice, runs a deterministic
self-check, and writes a Markdown report under `.artifacts/qa-e2e/`.

Private debugger UI:

```bash
pnpm qa:lab:up
```

That one command builds the QA site, starts the Docker-backed gateway + QA Lab
stack, and prints the QA Lab URL. From that site you can pick scenarios, choose
the model lane, launch individual runs, and watch results live.

Full repo-backed QA suite:

```bash
pnpm openclaw qa suite
```

That launches the private QA debugger at a local URL, separate from the
shipped Control UI bundle.

## Scope

Current scope is intentionally narrow:

- bus + plugin transport
- threaded routing grammar
- channel-owned message actions
- Markdown reporting
- Docker-backed QA site with run controls

Follow-up work will add:

- provider/model matrix execution
- richer scenario discovery
- OpenClaw-native orchestration later

## Related

- [Pairing](/channels/pairing)
- [Groups](/channels/groups)
- [Channels overview](/channels)
