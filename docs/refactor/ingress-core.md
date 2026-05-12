---
summary: "Deletion-first plan for moving repeated channel ingress glue into core."
read_when:
  - Auditing why the channel ingress refactor added too much code
  - Moving route, command, event, activation, or access-group policy from bundled plugins into core
  - Reviewing whether a channel ingress helper actually deletes bundled plugin code
title: "Ingress core deletion plan"
sidebarTitle: "Ingress core deletion"
---

# Ingress core deletion plan

The ingress refactor is not healthy while it adds thousands of net lines. Core
centralization only counts when bundled plugin production code gets smaller and
old third-party SDK compatibility is quarantined to SDK/core shims.

Desired runtime shape:

```text
bundled plugin event
  -> extract platform facts locally
  -> resolve shared ingress once when facts are available
  -> branch on generic ingress projections/outcomes
  -> perform platform side effects locally

old third-party helper
  -> SDK compatibility shim
  -> shared ingress-compatible projection where possible
  -> old return shape preserved
```

Bundled plugins should not translate ingress back into local `AccessResult`,
`GroupAccessDecision`, `CommandAuthDecision`, `DmCommandAccess`, or
`{ allowed, reasonCode }` shapes unless that type is public plugin API.

## Budget

Measured against the PR merge-base with `origin/main`, including untracked
files.

```text
merge-base            1671e7532adb

current:
core production       +3,922 / -546    = +3,376
docs                  +601 / -17       = +584
other                 +145 / -2        = +143
plugin production     +4,148 / -5,388  = -1,240
tests                 +2,326 / -2,414  = -88
total                 +11,142 / -8,367 = +2,775

required:
plugin production     <= -1,500
core production       <= +1,500, or paid for by larger plugin deletion
tests                 <= +1,000
total                 <= +2,000

stretch:
plugin production     <= -2,500
core production       <= +1,200
total                 <= 0
```

Minimum remaining cleanup:

```text
plugin production     needs 260 more net deleted lines
total                 needs 775 more net deleted lines
core production       still +1,876 over standalone budget, unless paid down by plugin deletion
```

Comment-only deletion does not count as cleanup. The previous budget pass was
too generous because it included restored QQBot explanatory comments; this
document tracks executable/docs/test code movement only.

Re-measure after each cleanup wave:

```sh
base=$(git merge-base HEAD origin/main)
git diff --shortstat "$base"
git diff --numstat "$base" -- src/channels/message-access src/plugin-sdk extensions | sort -nr -k1 | head -n 80
pnpm lint:extensions:no-deprecated-channel-access
```

## Diagnosis

The first pass added the shared ingress kernel, then left too much plugin-local
authorization beside it:

```text
platform facts
  -> shared ingress state and decision
  -> plugin-local DTO or legacy projection
  -> plugin-local if/else ladder
```

That duplicates the model. Core production grew by about 3,376 lines, while
bundled plugin production is 1,240 lines smaller. That is better than the first
pass, but it is not inside the minimum budget. The fix remains deletion-first:

- delete plugin DTOs that only rename ingress fields
- delete tests that only assert wrapper shape
- add core helpers only when the same patch deletes bundled plugin code
- keep old SDK compatibility in SDK/core shims only
- repack core after wrapper deletion exposes the stable shape

## Hotspots

Positive bundled production files that still need to shrink:

```text
extensions/telegram/src/ingress.ts                        +126
extensions/discord/src/monitor/dm-command-auth.ts         +101
extensions/signal/src/monitor/access-policy.ts             +92
extensions/feishu/src/policy.ts                            +85
extensions/slack/src/monitor/auth.ts                       +64
extensions/googlechat/src/monitor-access.ts                +59
extensions/nextcloud-talk/src/inbound.ts                   +51
extensions/matrix/src/matrix/monitor/access-state.ts       +49
extensions/irc/src/inbound.ts                              +44
extensions/imessage/src/monitor/inbound-processing.ts      +36
extensions/qa-channel/src/inbound.ts                       +34
extensions/qqbot/src/bridge/sdk-adapter.ts                 +33
extensions/tlon/src/monitor/utils.ts                       +30
extensions/twitch/src/access-control.ts                    +22
extensions/qqbot/src/engine/commands/slash-command-handler.ts +20
extensions/telegram/src/bot-handlers.runtime.ts            +19
```

The branch is not inside the minimum budget yet. The remaining review-relevant
work should delete repeated authorization flow, turn scaffolding, or wrapper
tests before adding another core abstraction.

## Current Code Read

The healthy core seam already exists in `src/channels/message-access/runtime.ts`:
it owns identity adapters, effective allowlists, pairing-store reads, route
descriptors, command/event presets, access groups, and the final resolved
`ResolvedChannelMessageIngress` projection.

The remaining growth is mostly plugin glue layered on top of that seam:

- `extensions/telegram/src/ingress.ts` wraps core decisions in Telegram-specific
  command/event helpers, then call sites still pass precomputed normalized
  allowlists and owner lists.
- `extensions/discord/src/monitor/dm-command-auth.ts`,
  `extensions/feishu/src/policy.ts`, `extensions/googlechat/src/monitor-access.ts`,
  and `extensions/matrix/src/matrix/monitor/access-state.ts` still keep
  local policy DTOs or legacy decision names beside ingress.
- `extensions/signal/src/monitor/access-policy.ts` correctly keeps Signal
  identity normalization and pairing replies local, but still has a wrapper
  seam that should collapse into direct ingress consumption.
- `extensions/nextcloud-talk/src/inbound.ts`, `extensions/irc/src/inbound.ts`,
  `extensions/qa-channel/src/inbound.ts`, `extensions/zalo/src/monitor.ts`, and
  `extensions/zalouser/src/monitor.ts` still repeat route/envelope/turn
  assembly that can move to shared turn helpers outside the ingress kernel.

Conclusion: moving more code into core is only useful if it deletes these
plugin wrapper layers in the same patch. Adding another abstraction while
leaving wrapper returns in place repeats the mistake.

## Boundary

Core owns generic policy:

- allowlist normalization and matching
- access-group expansion and diagnostics
- pairing-store DM allowlist reads
- route, sender, command, event, and activation gates
- admission mapping: dispatch, drop, skip, observe, pairing
- redacted state, decisions, diagnostics, and SDK compatibility projections
- reusable generic descriptors for identity, route, command, event, activation,
  and outcomes

Plugins own transport facts and side effects:

- webhook/socket/request authenticity
- platform identity extraction and API lookups
- channel-specific policy defaults
- pairing challenge delivery, replies, acks, reactions, typing, media, history,
  setup, doctor, status, logs, and user-facing copy

Core must stay channel-agnostic: no Discord, Slack, Telegram, Matrix, room,
guild, space, API client, or plugin-specific default in
`src/channels/message-access`.

## Acceptance Rule

Every new core helper must delete bundled plugin production code immediately.

```text
one bundled caller        reject; keep plugin-local
two bundled callers       accept only if plugin production LOC drops
three or more callers     plugin deletion must be at least 2x new core LOC
compatibility-only helper SDK/core shim only; never bundled hot paths
```

Stop and redesign if:

- plugin production LOC increases
- tests grow faster than production shrinks
- a bundled hot path returns a DTO that only renames `ResolvedChannelMessageIngress`
- a core helper needs a channel id, platform object, API client, or
  channel-specific default

## Work Packages

1. Freeze the budget.
   Put LOC in the PR, keep deprecated-ingress lint green, and include before/after
   LOC in cleanup commits.

2. Delete thin DTO seams.
   Replace plugin-local wrapper returns with `ResolvedChannelMessageIngress`,
   `senderAccess`, `commandAccess`, `routeAccess`, or `ingress` directly. Start
   with QQBot, Telegram, Slack, Discord, Signal, Feishu, Matrix, iMessage, and
   Tlon. Delete wrapper-shape tests; keep behavior tests.

3. Add outcome classification only with deletions.
   A generic classifier may expose `dispatch`, `pairing-required`,
   `skip-activation`, `drop-command`, `drop-route`, `drop-sender`, and
   `drop-ingress`. It must derive from the decision graph, not reason strings,
   and migrate at least three plugins in the same patch.

4. Add route descriptor builders only with deletions.
   Generic route target and route sender helpers are acceptable only if they
   immediately shrink route-heavy plugins: Google Chat, IRC, Microsoft Teams,
   Nextcloud Talk, Mattermost, Slack, Zalo, and Zalo Personal.

5. Add command/event presets only with deletions.
   Centralize text-command, native-command, callback, and origin-subject shapes.
   Command consumers must default to unauthorized when no command gate ran;
   events must not start pairing.

6. Add identity presets only where they remove boilerplate.
   Stable-id, stable-id-plus-aliases, phone/e164, and multi-identifier helpers
   are allowed when raw values enter only adapter input and redacted state keeps
   opaque ids/counts.

7. Share authorized turn assembly.
   Outside the ingress kernel, remove repeated route/envelope/context/reply
   scaffolding from QA Channel, IRC, Nextcloud Talk, Zalo, and Zalo Personal.
   Core may own route/session/envelope/dispatch sequencing; plugins keep
   delivery and channel-specific context.

8. Quarantine compatibility.
   Deprecated SDK helpers stay source-compatible, but bundled hot paths must not
   import deprecated ingress or command-auth facades. Compatibility tests should
   use fake third-party plugins, not bundled-plugin internals.

9. Repack core.
   After wrapper deletion, collapse one-use modules, remove unused exports, move
   compatibility projection out of hot paths, and keep focused tests for identity,
   route, command/event, activation, access groups, and compatibility shims.

## Deletion Waves

Run these in order. Each wave must lower bundled production LOC.

1. Wrapper collapse, expected plugin delta: -400 to -600.
   Replace plugin-local `resolveXAccess`, `resolveXCommandAccess`, and
   `accessFromIngress` result types with direct reads from
   `ResolvedChannelMessageIngress`. First targets: Discord DM command auth,
   Feishu policy, Matrix access state, Telegram ingress, Signal access policy,
   QQBot SDK adapter.

2. Shared outcome helpers, expected plugin delta: -200 to -350.
   Add one generic classifier only if it deletes repeated
   `shouldBlockControlCommand`, pairing, activation skip, route block, and sender
   block ladders across at least three plugins.

3. Route descriptor builders, expected plugin delta: -200 to -350.
   Move repeated route target and route sender descriptor assembly into core
   helpers. First targets: Google Chat, IRC, Microsoft Teams, Nextcloud Talk,
   Mattermost, Slack, Zalo, Zalo Personal.

4. Turn assembly sharing, expected plugin delta: -250 to -450.
   Use common route/session/envelope/dispatch sequencing for simple inbound
   plugins. First targets: QA Channel, IRC, Nextcloud Talk, Zalo, Zalo Personal.

5. Core repack, expected core delta: -300 to -700.
   After plugins consume runtime projections directly, delete one-use modules,
   merge tiny files back into `runtime.ts` or focused siblings, and keep SDK
   compatibility files separate from bundled hot paths.

6. Test pruning, expected test delta: -300 to -600.
   Delete tests that only assert removed wrapper shapes. Keep behavior tests for
   command denial, group fallback, origin-subject matching, activation skip,
   access groups, pairing, and redaction.

Expected minimum landing shape after these waves:

```text
plugin production     <= -1,500
core production       about +1,800 to +2,200 before final repack
tests                 <= +500
total                 <= +2,000
```

## Do Not Move

Do not move platform config defaults, setup UX, doctor/fix copy, API lookups,
Slack owner-presence checks, Matrix alias/verification handling, Telegram
callback parsing, command syntax parsing, native command registration, reaction
payload parsing, pairing replies, command replies, acks, typing, media, history,
or logs.

## Verification

Targeted local loop:

```sh
pnpm lint:extensions:no-deprecated-channel-access
pnpm test src/channels/message-access/message-access.test.ts src/plugin-sdk/channel-ingress-runtime.test.ts src/plugin-sdk/access-groups.test.ts
pnpm test extensions/<changed-plugin>/src/...
pnpm plugin-sdk:api:check
pnpm config:docs:check
pnpm check:docs
git diff --check
```

Use Testbox for broad changed gates/full-suite proof once the LOC trend is
inside budget.

Each work package records:

- before/after LOC by category
- deleted plugin wrappers
- new core helper LOC, if any
- targeted tests run
- remaining hotspot list

## Exit Criteria

- bundled production imports no deprecated channel-access or command-auth facades
- compatibility code is isolated to SDK/core seams
- bundled plugins consume ingress projections or generic outcomes directly
- plugin production LOC is at least 1,500 net negative against `origin/main`
- core production LOC is `<= +1,500`, or any excess is paid for while total
  stays `<= +2,000`
- representative tests cover redaction, route, command/event, activation,
  access-group, and channel-specific fallback behavior
