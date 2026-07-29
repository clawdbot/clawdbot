---
summary: "Implementation plan for the custodian onboarding redesign (living document)"
read_when:
  - You are implementing or reviewing a phase of the onboarding redesign
title: "Onboarding redesign"
---

# Onboarding redesign implementation plan

> **Living document.** This page tracks the custodian onboarding redesign at
> implementation level and is updated as each phase lands. When the last phase
> merges, this page is rewritten as the user-facing onboarding guide and joins
> the docs navigation. It is intentionally not in `docs.json` until then.

## North star

A non-technical user types `openclaw onboard` (or opens the app) and is greeted
by one conversational presence — OpenClaw, the system custodian ("custodian" is
the internal name only; the user always sees "OpenClaw") — that finds their AI,
sets everything up with announced defaults instead of questions, hatches their
agent as a visible identity moment, and stays reachable forever after as the
system's caretaker. Magic by default, one consent boundary, no dead ends.

Design principles (decided, do not relitigate casually):

- **Announced defaults with easy undo** replace blocking questions. The only
  hard requirement is working inference; everything else is an offer.
- **Question zero is the consent boundary**: "Full access" (recommended) means
  discovery is silent and automatic; "Ask first" gates every discovery — AI
  scanning, app scanning, and memory-source scanning alike — behind one
  explicit yes, with a fully manual path that never scans.
- **Conversation as UI with progressive intelligence**: the custodian surface
  exists before any AI works (scripted dialogue), becomes model-backed the
  moment a route verifies, and visibly says so. It never fakes intelligence:
  free-text input before a route verifies gets a graceful "let me get my brain
  working first".
- **The hatch is a ceremony**: same thread, avatar swap, the agent names itself
  and picks its own face. The custodian teaches the hierarchy once: "ask me
  about the system, or just ask your agent — it relays."
- **Trust is tiered by source**: official catalog entries may be pre-selected;
  third-party ClawHub skills are never pre-selected regardless of model
  ranking, and their labels say they install the publisher's code.
- **Configured installs are sacred**: re-running onboarding is a verification
  pass. It never re-applies setup and never restarts the Gateway service.
- **The terminal is the fallback, not a question**: prefer the browser
  dashboard when a gateway is reachable; never ask "terminal or browser?".
- **Weak models get a trimmed surface** (auto `localModelLean`), explained in
  plain words — never in terms of tools, code mode, or context windows.

## Current shipped flow (after phases 1-3)

`openclaw onboard` on a fresh macOS install, happy path — four Enters total:

1. Security note → one Enter to acknowledge (persisted; never asked again).
2. **Question zero**: "How should I set things up?" — Full access (recommended)
   or Ask first. Persisted as `wizard.accessMode`; reruns default to the saved
   choice. Guarded + "configure manually" reaches the provider picker without
   any scanning and skips memory-source scanning too.
3. **Discovery theater**: detects coding CLIs, env keys, and local runtimes;
   quips when coding agents are found; live-tests candidates in order and
   quietly collects failures into one summary line (details behind "See other
   options"). The first working route is announced as a default with a
   one-keystroke path to the full picker; exploring and skipping keeps the
   working route.
4. Memory-import offer (Claude Code / Codex / Hermes), skipped when discovery
   was declined.
5. Fresh installs only: the standard setup plan applies automatically
   (workspace, Gateway service, sessions — the same plan the conversational
   "yes" runs). Configured installs print "already set up" and never touch the
   service.
6. **App recommendations**: installed apps matched by the verified model
   against official catalogs + ClawHub; official channel plugins arrive
   pre-checked, third-party skills opt-in with a warning label. Skippable;
   kill switch `wizard.appRecommendations`.
7. **Hatch**: when a gateway is reachable, the browser handoff opens (GUI) or
   prints (headless/SSH) the dashboard URL and waits for the Control UI to
   connect — "Dashboard connected — continuing in your browser." Otherwise, or
   with `--tui`, the terminal TUI opens seeded with the bootstrap hatch
   message and the agent introduces itself.

Remote-gateway onboarding keeps its legacy conversational handoff
(`handoffMode: "chat"`); setup must apply on the remote gateway.

## Phases

| #   | Phase                                                                                                                                                     | Surface              | Status                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Installed-app plugin recommendations (scan, candidates, AI matcher, wizard step, `device.apps` node command)                                              | classic + guided CLI | merged ([#109668](https://github.com/openclaw/openclaw/pull/109668))                                                              |
| 2   | CLI custodian spine (question zero, discovery theater, auto-apply + hatch)                                                                                | guided CLI           | merged ([`a83ed13204f1`](https://github.com/openclaw/openclaw/commit/a83ed13204f118adf1009e5ac88d5afe1905b86c))                   |
| 3   | Browser-first handoff (GUI-session detection, wait-for-dashboard-connect, TUI as fallback)                                                                | CLI → web            | merged ([#110054](https://github.com/openclaw/openclaw/pull/110054))                                                              |
| 4   | Web custodian surface (option cards, typed `question` field on `openclaw.chat`, wizard-step mirroring, first-run handoff)                                 | Control UI           | merged ([#110141](https://github.com/openclaw/openclaw/pull/110141), [#110242](https://github.com/openclaw/openclaw/pull/110242)) |
| 5   | Hatch and bootstrap (recommendations store with once-semantics, self-naming birth sequence, auto-hatch handoff after fresh setup; avatar ladder deferred) | agent bootstrap      | merged ([#110173](https://github.com/openclaw/openclaw/pull/110173), [#110331](https://github.com/openclaw/openclaw/pull/110331)) |
| 6   | Custodian presence PR1 (pinned sidebar entry, Ask OpenClaw in Settings, normal-chrome caretaker greeting; event commentary and channel summon are PR2)    | web + channels       | merged ([#110269](https://github.com/openclaw/openclaw/pull/110269))                                                              |
| 7   | Resilience (custodian reachable on broken config, partial-surface salvage, auto-doctor)                                                                   | gateway              | follow-up                                                                                                                         |

## Implementation notes per phase

### Phase 1 — app recommendations (PR #109668)

- Scanner: `src/infra/installed-apps.ts` (TCC-free macOS enumeration; follows
  symlinked `.app` bundles).
- Candidates: official catalogs + ClawHub search, 20s overall budget, graceful
  offline degradation to catalog-only candidates. Catalog entries are package
  manifests without a top-level `id` — candidates are keyed by the resolved
  plugin id (regression-tested against the real bundled catalogs; keying by
  `entry.id` once collapsed the whole catalog and dropped every official
  recommendation).
- AI matcher: one completion on the verified route
  (`src/system-agent/setup-app-recommendations.ts`); no curated bundle-id map —
  the model rejects coincidental name overlaps. Output is bounded by the
  resolved model's own `maxTokens` budget (the stream layer applies it when no
  explicit cap is passed).
- **Supply-chain guard**: ClawHub listing text is publisher-controlled and
  reaches the matcher prompt, so a listing can promote itself to
  "recommended". Only official catalog entries may be pre-selected; ClawHub
  skills always require an explicit tick and are labeled "third-party ClawHub
  skill; installs its publisher's code".
- Node command `device.apps` (TS node-host, Android envelope parity), sharing
  off by default; gateway kill switch `wizard.appRecommendations`.
- Delivery lives in the classic wizard and guided custodian flow
  (`src/wizard/setup.app-recommendations.ts`); re-targeting to the bootstrap
  tail remains phase 5 (the service already takes an injectable inventory
  source). Once-semantics (offer only until accepted, stored scan) also lands
  with the phase 5 store; today a rerun re-offers.
- Also fixed: custom `completeSetupInference` prompts no longer inherit the
  32-token verification-probe output cap (`SETUP_INFERENCE_TEST_MAX_TOKENS`
  applies to the "reply OK" probe only).

### Phase 2 — CLI custodian spine (PR #109841)

- Flow rework in `src/commands/onboard-guided.ts`; remote-gateway onboarding
  keeps its legacy chat handoff via `handoffMode: "chat"`.
- Question zero persists `wizard.accessMode` ("full" | "guarded"); reruns
  default to the saved choice (accepting the default can never silently
  downgrade guarded to full). Guarded + manual uses
  `listManualSetupInferenceOptions` (config/manifests only, no probing) and
  skips memory-source scanning.
- Discovery: quiet failure collection (single summary line; details behind
  "See other options"), coding-agent quip, announced route default. Session
  counts in the quip are deferred (qualitative only) until a cheap
  session-count seam exists.
- Fresh installs: `applySystemAgentSetup` (the deterministic conversational
  "yes"), then hatch via `launchTuiCli` seeded with the bootstrap message.
  Configured installs (pre-existing model or gateway config — wizard
  timestamps prove nothing, they are shared with configure/doctor):
  verification only — no apply, no Gateway service restart. Apply failure
  falls back to the conversational chat.

### Phase 3 — browser-first handoff (PR #110054, merged)

- `src/commands/onboard-browser-handoff.ts` owns pure graphical-session
  detection (`SSH_CONNECTION`/`SSH_TTY`; `DISPLAY`/`WAYLAND_DISPLAY` on Linux)
  and the 60-second GUI / 300-second SSH wait. Guided onboarding currently
  enables the handoff only on macOS; `--tui` and other platforms keep the
  terminal hatch. Linux/Windows enablement is a follow-up.
- Dashboard links use the same `resolveAdvertisedControlUiLinks`,
  `resolveLocalControlUiProbeLinks`, and `buildOnboardingControlUiUrl` helpers
  as classic finalize. Browser launch uses the shared `openUrl` helper.
- Readiness polls the existing `system-presence` RPC as a **CLI-mode loopback
  client presenting the configured shared secret** — the trusted path every
  `openclaw` command uses. A raw shared-auth Control UI client is rejected
  with "device identity required" on SecretRef gateways. The reachability
  preflight resolves the same target (and secret) as the wait loop, so the
  gate and the wait can never disagree on auth. The handoff completes only
  when a connected `openclaw-control-ui`/`webchat` presence row is new
  relative to the pre-launch baseline (an already-open dashboard cannot
  complete it).
- `gateway.controlUi.enabled: false` short-circuits before any URL is shown.
- Proven end-to-end against an isolated same-config gateway: URL print → real
  browser connect → "Dashboard connected — continuing in your browser" → no
  terminal hatch. An earlier "token mismatch" hold was a test-harness
  artifact — see the testing playbook below.

### Phase 4 — web custodian surface (merged: #110141, #110242)

- `/custodian` page over `openclaw.chat` with the option-card component
  (2-4 cards, one recommended max, always skippable); onboarding chrome via
  `?onboarding=1`; model-setup first-run completion hands off into it.
- Structured questions are a typed additive `question` field on
  `SystemAgentChatResult` (per-option `reply` text; prose always stands alone
  for the macOS app/TUI). Producers: both onboarding welcome variants and
  hosted wizard select/confirm steps with 2-4 closed options — real channel
  wizards render as cards. The PR1 string-marker stopgap was deleted.
- Session ownership is scoped to gateway URL + every presented credential
  (token, password, bootstrap token, stored device token — sticky across
  transient hello drops); failed user turns are never replayable; sensitive
  input is sent verbatim and masked in the transcript.

### Phase 5 — hatch and bootstrap (merged: #110173, #110331)

- Custodian creates a nameless agent (tool call); the agent's bootstrap opens
  with self-naming. PR1 ships the ceremony capped at three beats (name → soul
  line → skills question) and defers the self-drawn avatar/image-gen ladder
  (model-generated candidates → preset marks → keep logo) to a follow-up. Same
  thread, avatar swap; the claw mark stays reserved for the custodian. The
  agreed identity persists twice: into `IDENTITY.md`/`SOUL.md` (what the agent
  reads) and via `openclaw agents set-identity` (what channels and the UI
  display).
- Recommendations (phase 1 service, stored scan with once-semantics) land as
  the last bootstrap step before the bootstrap file is removed: "minimal set
  or maximum convenience?" The bootstrap reads the stored offer via
  `openclaw onboard recommendations --json` (opaque install IDs only) and
  acknowledges it after the choice is handled so it never asks again. Channel
  connect buttons carry per-channel setup playbooks; the agent collects
  credentials conversationally and relays config writes to the custodian
  ("asking OpenClaw…" is the canonical idiom).
- Self-learning is asked, not announced, and doubles as skill-workshop
  consent; describe ClawHub's release-trust, scan, verification, and integrity
  checks plus the publisher-code warning — never imply every release is signed.
- Auto-hatch shipped: a fresh-install setup apply announces the hatch and
  hands off (terminal TUI / `open-agent` for gateway clients); the web page
  lands in agent chat with the "Wake up, my friend!" draft prefilled. The
  handoff fires only on clean post-write verification. Zero agents after
  deletion offering (instead of auto) remains follow-up polish.

### Phase 6 — custodian presence (PR1 merged: #110269; commentary/summon are PR2)

- Shipped in PR1: default-pinned "OpenClaw" sidebar entry (fresh profiles;
  existing users keep saved pins and reach it via customize/More), "Ask
  OpenClaw" as the first Settings entry, and normal-chrome `/custodian` visits
  that request the caretaker greeting (no onboarding welcome variant), with
  Exit setup rendered only in onboarding mode. A docked inline Settings pane
  needs shared conversation-view extraction (follow-up).
- Event-reactive commentary with anti-Clippy guardrails: consequential or
  failed changes only, at most once per settings visit unless asked. The same
  event seam makes the custodian the voice for degraded auth or broken
  channels later.
- Channels: day-to-day invisible (the agent relays); reachable by explicit
  summon and on agent-down events in the same thread, with its own name and
  claw avatar where the platform allows.
- Weak model detected at setup: auto-set `localModelLean`, and the custodian
  says so in plain words with an upgrade offer.
- The custodian knows its internal nickname ("some folks call me the
  custodian — OpenClaw's fine") and always refers to the agent by name.

### Phase 7 — resilience (needs an owner decision before building)

The original sketch — "the custodian must be reachable no matter how broken
the config is" — collides with the repo's security policy: the root guide
states the Gateway **refuses startup** when config is structurally invalid,
and only SecretRef-owner failures degrade into configured-unavailable
capabilities. Serving any surface from an invalid config is a policy change,
not an implementation detail. Two scopes, pick one:

- **Option A (recommended, policy-compliant): CLI-side auto-doctor.** When a
  gateway or CLI start fails with a known-shape invalid config, the CLI offers
  (or with consent runs) `openclaw doctor --fix`, then retries once and
  reports plainly. No gateway behavior changes; the custodian stays reachable
  through the existing degraded-SecretRef path and the terminal.
- **Option B (needs explicit owner sign-off + security review): gateway
  minimal-surface mode.** On structurally invalid config, start a locked-down
  surface serving only the custodian conversation and doctor actions. This
  rewrites the fail-closed startup contract and must define its own ingress
  protection story before any code.

Remaining follow-ups from phases 4-6 (tracked, unscheduled): avatar/image-gen
ladder for the hatch; macOS app rendering of the typed `question` field; a
docked inline Settings pane for the custodian (needs shared conversation-view
extraction); event-reactive commentary and channel summon/agent-down recovery
(phase 6 PR2); automatic `localModelLean` for weak models; whether existing
users' saved sidebar pins should adopt the OpenClaw entry.

## Testing and landing playbook (hard-won; read before phases 4-6)

- **`OPENCLAW_STATE_DIR` does not isolate the Gateway service.** The
  LaunchAgent label (`ai.openclaw.gateway`) is machine-global: a fresh-install
  onboarding test with an isolated state dir will REWRITE and RESTART the real
  machine's service (wrapper scripts land inside the isolated dir; the next
  service start breaks when that dir is cleaned). After any fresh-install
  test, restore with `openclaw gateway install --force && openclaw gateway
restart` from the real environment and verify the plist. Product follow-up:
  state-dir-scoped service labels, or onboarding detecting a foreign service.
- **Safe end-to-end harness**: pre-seed the isolated config with a `gateway`
  section (so onboarding takes the configured-install path and never touches
  the service) and run `openclaw gateway run` as a plain foreground process on
  a spare port with a plain token. That harness proved the phase-3 loop,
  including a real browser connect.
- **Auth paths differ by client identity, not only credentials.** Presence and
  other operator reads use a CLI-mode loopback client with credentials from the
  same config. Token-auth gateways require the shared secret; SecretRef/none
  gateways can fall back to trusted-loopback auth without a token. A Control
  UI-identified browser client needs device identity or the secure-context
  loopback grant. A probe authenticating against a gateway that serves a
  DIFFERENT config (see LaunchAgent pitfall) fails with "token mismatch" — that
  artifact briefly held phase 3.
- **Completion probes**: `runSetupInferenceTest` caps the verification probe at
  32 output tokens; custom prompts bypass the cap and are bounded by the
  model's own `maxTokens`. Reasoning models consume that budget with hidden
  reasoning first — an empty-text turn usually means the budget died there.
- **Agent landing needs exact-head hosted CI.** The heavy `CI` workflow may
  not queue on pushes under org load; the maintainer fallback is a
  release-gate dispatch on the PR branch:

  ```bash
  gh workflow run ci.yml --ref <branch> -f target_ref=<head-sha> -f release_gate=true -f pull_request_number=<pr>
  ```

  The run must be on the
  branch ref so `head_sha` matches, and the title becomes
  `CI release gate <sha>`, which `scripts/verify-pr-hosted-gates.mjs`
  accepts. Then `scripts/pr` prepare/merge as usual.

- **Gates that CI enforces beyond focused tests**: docs map
  (`pnpm docs:map:gen` after adding any docs page), oxlint (`no-map-spread`,
  `max-lines` — split files, never suppress), `check:test-types`, knip
  deadcode (export only what prod consumes; route tests through public APIs),
  and the live-test shard classifier
  (`test/scripts/test-live-shard.test.ts` must list any new `*.live.test.ts`).

## Decision log

- Magical scan with kill switch, not consent-first (phase 1; persistent output
  discloses model and ClawHub use before scanning, and the results note repeats it).
- Full vertical including the node `device.apps` command (phase 1).
- Third-party ClawHub skills are never pre-selected and are labeled as
  installing the publisher's code; official entries may be pre-checked
  (phase 1, shipped security posture).
- Two access cards, not three; consent front-loaded into the choice (phase 2).
- Auto-hatch with announcement, not a blocking button (phases 2/5).
- Browser-first: the terminal hatch is the fallback, never a "terminal or
  browser?" question (phase 3).
- Custodian gets channel presence (summon + recovery), not web/CLI only
  (phase 6).
- Hatch happens in the same thread with an avatar swap; after completion the
  app transitions to the regular UI (phase 5).
- The settings surface keeps the name "Settings"; the custodian lives there
  (and in the sidebar) rather than replacing it (phase 6).
- Option cards are constrained: 2-4 options, exactly one recommended, always
  skippable; the same component serves onboarding and the agent question tool
  (phase 4).
- "Asking OpenClaw…" is the canonical delegation idiom; souls may add flavor,
  the tool narration stays plain (phase 5).
- User-facing copy never says "code mode", "tools", or "context window" when
  explaining weak-model trimming (phase 6).

## Known gaps and follow-ups

- LaunchAgent label is not state-dir-scoped (testing pitfall above; also a
  real multi-instance product gap).
- Recommendations once-semantics and the stored scan (phase 5); reruns
  currently re-offer.
- Browser handoff is macOS-only; Linux/Windows enablement pending.
- Session-count quip is qualitative; counts need a cheap session-count seam.
- Browser handoff lands on the normal dashboard; onboarding-mode custodian
  deep-link arrives with phase 4.
