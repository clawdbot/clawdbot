# RTT regression audit checkpoint

Status: branch-local checkpoint, not release notes.

## Signals

- `openclaw-rtt` Discord main rows appeared to jump from about 5-7s p50 to about
  24-27s p50 after the 2026-05-16 main window.
- Downloaded fast/slow Discord artifacts showed the old "fast" run included
  observed message `triggerTimestamp` and `timestamp`, while newer redacted runs
  kept only scenario metadata.
- `openclaw-rtt` `scripts/import-discord-rtt.mjs` falls back to whole summary
  duration when observed-message timestamps are missing. That made a redaction
  shape change look like transport RTT regression.
- Slack and WhatsApp RSS rows showed recurring first-sample max RSS outliers
  around 6-9GB while later warm samples sat far lower. That points at
  command-level cold-start RSS measurement before retained gateway heap.

## Fixes in this branch

- `extensions/qa-lab/src/live-transports/discord/discord-live.runtime.ts`
  preserves safe timing fields through metadata redaction so importers can keep
  measuring reply RTT without exposing Discord IDs or content.
- Discord QA scenario summaries now include `rttMs` for direct importer use.
- `extensions/qa-lab/src/suite.ts` records gateway-process RSS start/end/peak
  and checkpoint samples in `qa-suite-summary.json`, giving RTT importers a
  gateway-level metric separate from `/usr/bin/time` command max RSS.

## Proof so far

- Focused local wrapper:
  `node scripts/run-vitest.mjs extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts`
  passed 30 tests.
- Focused local wrapper:
  `node scripts/run-vitest.mjs extensions/qa-lab/src/suite.test.ts extensions/qa-lab/src/suite.summary-json.test.ts extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts`
  passed 52 tests after the final rebase.
- Testbox `tbx_01krvces8y0c99nzra2a90jg13` ran
  `pnpm openclaw qa suite --scenario channel-chat-baseline` and emitted gateway
  RSS trace fields. Observed sample: wall `15784ms`, gateway RSS
  `664403968 -> 689852416`, peak `689852416`.
- Testbox `tbx_01krwb9k7cbktytpjprxcydfbk` ran `pnpm check:changed` and the
  command exited 0. The wrapper Actions run `26008757251` still reported
  `in_progress` after the box was stopped.
- Testbox `tbx_01krwbsg15xvjdgpcz8fxq1htz` ran
  `OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS=1 pnpm openclaw qa suite --scenario channel-chat-baseline`.
  The sample passed and recorded heap checkpoints plus RSS trace: wall
  `20112ms`, gateway RSS `655036416 -> 953790464`, peak `1051258880`, heap
  snapshots `154M` and `165M`.
- After rebasing onto `b5046968f61`, a fresh Testbox `pnpm check:changed`
  attempt on `tbx_01krwbsg15xvjdgpcz8fxq1htz` was blocked before reaching the
  changed gate: pnpm install rejected newly published
  `openclaw/plugin-sdk/llm@0.74.1` under `minimumReleaseAge`.
- After rebasing again, Testbox-through-Crabbox
  `tbx_01krwcxpxx1n22t8jmvcj40228` ran
  `pnpm check:changed` with an explicit `origin/main` fetch to repair the
  delegated shallow checkout's merge base, and passed. The run escalated to all
  changed-gate lanes in the delegated checkout, so it covered typecheck, lint,
  and runtime import-cycle checks rather than only the narrow qa-lab diff.
- Follow-up branch `perf/discord-rtt-summary-import` in `openclaw-rtt` updates
  `scripts/import-discord-rtt.mjs` to prefer the new summary `rttMs` field
  before observed-message or summary-duration fallback, and teaches Discord and
  live-transport importers to ingest gateway RSS summary metrics. `npm test -- scripts/import-discord-rtt.test.mjs scripts/import-live-transport-rtt.test.mjs`
  passed 19 tests and `npm run check` passed.

## Still weak

- No retained-heap regression has been proven. The first heap-checkpoint sample
  grew by about 11M on disk across the scenario, which is worth comparing
  across repeated warm samples before calling it a leak.
- The branch fixes OpenClaw artifact quality. `openclaw-rtt` has a paired
  importer branch for summary `rttMs` and gateway RSS metric ingestion;
  dashboard presentation of gateway RSS remains a later reporting decision.
- Gitcrawl data was stale for the newest RTT window, so live `gh` history was
  the source of truth for 2026-05-16 and 2026-05-17 PR attribution.
