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

## Exact-head rerun after review corrections

The proof was rerun on 2026-08-22 against behavior commit
`a1562db1d62274cf55a2a56e705fd1fd76fcbf0b` using a new disposable state
directory, a loopback-only Gateway, one synthetic session, and two locally
linked proof plugins. The first run exposed that normal Gateway shutdown was
incorrectly treating every loaded plugin as disabled and deleting its durable
session extensions. The shutdown path was corrected to preserve persistent
plugin session state while retaining normal in-process cleanup.

```text
[gateway] exact behavior commit: a1562db1d62274cf55a2a56e705fd1fd76fcbf0b
[gateway] loaded proof-owner and proof-other from disposable paths
[proof-owner] write {"checkpoint":"exact-head"}: PASS
[proof-owner] exact readback: PASS
[proof-other] same session and namespace returned no owner value: PASS
[gateway] graceful stop: PASS
[gateway] restart with same disposable state: PASS
[proof-owner] persisted readback after restart: PASS
[proof-owner] clear: PASS
[proof-owner] empty readback after clear: PASS
```

Focused shutdown, registry, and persistent-state tests passed 73/73, formatting
passed, and the full OpenClaw build passed. The disposable proof directory was
moved to Trash after the run. No production profile, credential, session,
connector, model call, message, or non-loopback endpoint was used.

## Active-generation authority proof

ClawSweeper's exact-head review identified a staged-replacement window that the
earlier Gateway trace did not exercise. The correction binds every retained
session-state closure to the exact active registry object and passes the same
assertion to the SQLite accessor's synchronous final-commit hook.

The regression fixture uses two registries containing the same plugin ID. The
original closure begins a write while its registry is active. Its projection
callback then stages the replacement registry after the initial authorization
check but before the SQLite transaction's final write. The final-commit fence
rejects the original closure, and direct store inspection confirms that neither
the plugin extension nor its promoted slot was written.

```text
[registry] original owner active: PASS
[session] retained original closure begins write: PASS
[registry] same-ID replacement staged before commit: PASS
[authority] retained closure rejected at final commit: PASS
[sqlite] plugin extension absent after rejection: PASS
[sqlite] promoted slot absent after rejection: PASS
[authority] subsequent retained-closure read rejected: PASS
```

The fixture is
`src/plugins/contracts/plugin-session-state-api.contract.test.ts` and runs
against a disposable session store. Combined with the real Gateway lifecycle
trace above, it covers both durable restart behavior and the replacement-stage
authority boundary without using production data.
