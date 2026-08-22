# PR #127982 real Gateway proof

Date: 2026-08-22

This is the redacted runtime trace for the plugin-scoped session-state API in
PR #127982. The test used a disposable OpenClaw profile, a loopback-only
Gateway, a synthetic session, and two test plugins. It used no production
credentials, sessions, connectors, model calls, messages, phone numbers,
public endpoints, or non-loopback IP addresses.

## Environment

- OpenClaw base: `v2026.7.1-2` (`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`)
- Host correction commit tested: `7287b6ad`
- Candidate plugin: `@kanary/active-project-anchor` `0.1.1`
- Gateway binding: loopback, disposable port (redacted)
- Backend service: local fixture only

## Trace

```text
[gateway] started with disposable profile
[plugin-owner] registered namespace active-project-anchor
[plugin-owner] write: PASS
[plugin-owner] exact readback: PASS
[plugin-other] cross-plugin read rejected: PASS
[gateway] stopped cleanly
[gateway] restarted with the same disposable profile
[plugin-owner] persisted readback after restart: PASS
[suite] governed continuity cases before restart: 18/18 PASS
[suite] governed continuity cases after restart: 18/18 PASS
[plugin-owner] clear: PASS
[plugin-owner] empty readback after clear: PASS
[gateway] stopped cleanly
```

The 18-case suite covered valid continuation, fresh-session clarification,
same-session reuse, transcript rotation, compaction, restart persistence,
stale and malformed anchors, identity mismatch, conversation mismatch,
ambiguous projects, explicit project switches, missing authority, and
cross-plugin isolation.

## Supporting verification

- Focused OpenClaw contract and loader tests: 184/184 passed.
- Candidate plugin tests: 22/22 passed.
- Full OpenClaw build: passed.
- Two independent plugin package builds were byte-identical:
  `0c21657863a2214b5bba51f07613b39959c611aab84b6a2f7252882d33a7a5d5`.
- The disposable profiles and package artifacts were removed after the run.

This artifact proves behavior of the API through a real Gateway lifecycle. It
does not authorize production installation or deployment.
