---
summary: "Maintainer reference for the Docker-backed Matrix live QA lane: CLI, profiles, env vars, scenarios, and output artifacts."
read_when:
  - Running pnpm openclaw qa matrix locally
  - Adding or selecting Matrix QA scenarios
  - Triaging Matrix QA failures, timeouts, or stuck cleanup
title: "Matrix QA"
---

The Matrix QA lane runs the bundled `@openclaw/matrix` plugin against a disposable Tuwunel homeserver in Docker, with temporary driver, SUT, and observer accounts plus seeded rooms. It is the live transport-real coverage for Matrix.

This is maintainer-only tooling. Packaged OpenClaw releases intentionally omit `qa-lab`, so `openclaw qa` is only available from a source checkout. Source checkouts load the bundled runner directly - no plugin install step is needed.

For broader QA framework context, see [QA overview](/concepts/qa-e2e-automation).

## Quick start

```bash
pnpm openclaw qa matrix --profile fast --fail-fast
```

Plain `pnpm openclaw qa matrix` runs `--profile all` and does not stop on first failure. Use `--profile fast --fail-fast` for a release gate; shard the catalog with `--profile transport|media|e2ee-smoke|e2ee-deep|e2ee-cli` when running the full inventory in parallel.

## What the lane does

1. Provisions a disposable Tuwunel homeserver in Docker (default image `ghcr.io/matrix-construct/tuwunel:v1.5.1`, server name `matrix-qa.test`, port `28008`).
2. Registers three temporary users - `driver` (sends inbound traffic), `sut` (the OpenClaw Matrix account under test), `observer` (third-party traffic capture).
3. Seeds rooms required by the selected scenarios (main, threading, media, restart, secondary, allowlist, E2EE, verification DM, etc.).
4. Starts a child OpenClaw gateway with the real Matrix plugin scoped to the SUT account; `qa-channel` is not loaded in the child.
5. Runs scenarios in sequence, observing events through the driver/observer Matrix clients.
6. Tears down the homeserver, writes report and summary artifacts, then exits.

## CLI

```text
pnpm openclaw qa matrix [options]
```

### Common flags

| Flag                  | Default                                       | Description                                                                                                            |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--profile <profile>` | `all`                                         | Scenario profile. See [Profiles](#profiles).                                                                           |
| `--fail-fast`         | off                                           | Stop after the first failed check or scenario.                                                                         |
| `--scenario <id>`     | -                                             | Run only this scenario. Repeatable. See [Scenarios](#scenarios).                                                       |
| `--output-dir <path>` | `<repo>/.artifacts/qa-e2e/matrix-<timestamp>` | Where reports, summary, observed events, and the output log are written. Relative paths resolve against `--repo-root`. |
| `--repo-root <path>`  | `process.cwd()`                               | Repository root when invoking from a neutral working directory.                                                        |
| `--sut-account <id>`  | `sut`                                         | Matrix account id inside the QA gateway config.                                                                        |

### Provider flags

The lane uses a real Matrix transport but the model provider is configurable:

| Flag                     | Default          | Description                                                                                                                               |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider-mode <mode>` | `live-frontier`  | `mock-openai` for deterministic mock dispatch or `live-frontier` for live frontier providers. The legacy alias `live-openai` still works. |
| `--model <ref>`          | provider default | Primary `provider/model` ref.                                                                                                             |
| `--alt-model <ref>`      | provider default | Alternate `provider/model` ref where scenarios switch mid-run.                                                                            |
| `--fast`                 | off              | Enable provider fast mode where supported.                                                                                                |

Matrix QA does not accept `--credential-source` or `--credential-role`. The lane provisions disposable users locally; there is no shared credential pool to lease against.

## Profiles

The selected profile decides which scenarios run.

| Profile         | Use it for                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all` (default) | Full catalog. Slow but exhaustive.                                                                                                                                                                                                   |
| `fast`          | Release-gate subset that exercises the live transport contract: canary, mention gating, allowlist block, reply shape, restart resume, thread follow-up, thread isolation, reaction observation, and exec approval metadata delivery. |
| `transport`     | Transport-level threading, DM, room, autojoin, mention/allowlist, approval, and reaction scenarios.                                                                                                                                  |
| `media`         | Image, audio, video, PDF, EPUB attachment coverage.                                                                                                                                                                                  |
| `e2ee-smoke`    | Minimum E2EE coverage - basic encrypted reply, thread follow-up, bootstrap success.                                                                                                                                                  |
| `e2ee-deep`     | Exhaustive E2EE state-loss, backup, key, and recovery scenarios.                                                                                                                                                                     |
| `e2ee-cli`      | `openclaw matrix encryption setup` and `verify *` CLI scenarios driven through the QA harness.                                                                                                                                       |

The exact mapping lives in `extensions/qa-matrix/src/runners/contract/scenario-catalog.ts`.

## Scenarios

The full scenario id list is the `MatrixQaScenarioId` union in `extensions/qa-matrix/src/runners/contract/scenario-catalog.ts:15`. Categories include:

- threading - `matrix-thread-*`, `matrix-subagent-thread-spawn`
- top-level / DM / room - `matrix-top-level-reply-shape`, `matrix-room-*`, `matrix-dm-*`
- streaming and tool progress - `matrix-room-partial-streaming-preview`, `matrix-room-quiet-streaming-preview`, `matrix-room-tool-progress-*`, `matrix-room-block-streaming`
- media - `matrix-media-type-coverage`, `matrix-room-image-understanding-attachment`, `matrix-attachment-only-ignored`, `matrix-unsupported-media-safe`
- routing - `matrix-room-autojoin-invite`, `matrix-secondary-room-*`
- reactions - `matrix-reaction-*`
- approvals - `matrix-approval-*` (exec/plugin metadata, chunked fallback, deny reactions, threads, and `target: "both"` routing)
- restart and replay - `matrix-restart-*`, `matrix-stale-sync-replay-dedupe`, `matrix-room-membership-loss`, `matrix-homeserver-restart-resume`, `matrix-initial-catchup-then-incremental`
- mention gating, bot-to-bot, and allowlists - `matrix-mention-*`, `matrix-allowbots-*`, `matrix-allowlist-*`, `matrix-multi-actor-ordering`, `matrix-inbound-edit-*`, `matrix-mxid-prefixed-command-block`, `matrix-observer-allowlist-override`
- E2EE - `matrix-e2ee-*` (basic reply, thread follow-up, bootstrap, recovery key lifecycle, state-loss variants, server backup behavior, device hygiene, SAS / QR / DM verification, restart, artifact redaction)
- E2EE CLI - `matrix-e2ee-cli-*` (encryption setup, idempotent setup, bootstrap failure, recovery-key lifecycle, multi-account, gateway-reply round-trip, self-verification)

Pass `--scenario <id>` (repeatable) to run a hand-picked set; combine with `--profile all` to ignore profile gating.

## Environment variables

| Variable                                | Default                                   | Effect                                                                                                                                                                                         |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_QA_MATRIX_TIMEOUT_MS`         | `1800000` (30 min)                        | Hard upper bound on the entire run.                                                                                                                                                            |
| `OPENCLAW_QA_MATRIX_CANARY_TIMEOUT_MS`  | `45000`                                   | Bound for the initial canary reply. Release CI raises this on shared runners so a slow first gateway turn does not fail before scenario coverage starts.                                       |
| `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` | `8000`                                    | Quiet window for negative no-reply assertions. Clamped to `≤` the run timeout.                                                                                                                 |
| `OPENCLAW_QA_MATRIX_CLEANUP_TIMEOUT_MS` | `90000`                                   | Bound for Docker teardown. Failure surfaces include the recovery `docker compose ... down --remove-orphans` command.                                                                           |
| `OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE`      | `ghcr.io/matrix-construct/tuwunel:v1.5.1` | Override the homeserver image when validating against a different Tuwunel version.                                                                                                             |
| `OPENCLAW_QA_MATRIX_PROGRESS`           | on                                        | `0` silences `[matrix-qa] ...` progress lines on stderr. `1` forces them on.                                                                                                                   |
| `OPENCLAW_QA_MATRIX_CAPTURE_CONTENT`    | redacted                                  | `1` keeps message body and `formatted_body` in `matrix-qa-observed-events.json`. Default redacts to keep CI artifacts safe.                                                                    |
| `OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT` | off                                       | `1` skips the deterministic `process.exit` after artifact write. The default forces exit because matrix-js-sdk's native crypto handles can keep the event loop alive past artifact completion. |
| `OPENCLAW_RUN_NODE_OUTPUT_LOG`          | unset                                     | When set by an outer launcher (e.g. `scripts/run-node.mjs`), Matrix QA reuses that log path instead of starting its own tee.                                                                   |

## Output artifacts

Written to `--output-dir`:

- `matrix-qa-report.md` - Markdown protocol report (what passed, failed, was skipped, and why).
- `matrix-qa-summary.json` - Structured summary suitable for CI parsing and dashboards.
- `matrix-qa-observed-events.json` - Observed Matrix events from the driver and observer clients. Bodies are redacted unless `OPENCLAW_QA_MATRIX_CAPTURE_CONTENT=1`; approval metadata is summarized with selected safe fields and truncated command preview.
- `matrix-qa-output.log` - Combined stdout/stderr from the run. If `OPENCLAW_RUN_NODE_OUTPUT_LOG` is set, the outer launcher's log is reused instead.

The default output dir is `<repo>/.artifacts/qa-e2e/matrix-<timestamp>` so successive runs do not overwrite each other.

## Triage tips

- **Run hangs near the end:** `matrix-js-sdk` native crypto handles can outlive the harness. The default forces a clean `process.exit` after artifact write; if you have unset `OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT=1`, expect the process to linger.
- **Cleanup error:** look for the printed recovery command (a `docker compose ... down --remove-orphans` invocation) and run it manually to release the homeserver port.
- **Flaky negative-assertion windows in CI:** lower `OPENCLAW_QA_MATRIX_NO_REPLY_WINDOW_MS` (default 8 s) when CI is fast; raise it on slow shared runners.
- **Need redacted bodies for a bug report:** rerun with `OPENCLAW_QA_MATRIX_CAPTURE_CONTENT=1` and attach `matrix-qa-observed-events.json`. Treat the resulting artifact as sensitive.
- **Different Tuwunel version:** point `OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE` at the version under test. The lane checks in only the pinned default image.

## Live transport contract

Matrix is one of three live transport lanes (Matrix, Telegram, Discord) that share a single contract checklist defined in [QA overview → Live transport coverage](/concepts/qa-e2e-automation#live-transport-coverage). `qa-channel` remains the broad synthetic suite and is intentionally not part of that matrix.

## Related

- [QA overview](/concepts/qa-e2e-automation) - overall QA stack and live transport contract
- [QA Channel](/channels/qa-channel) - synthetic channel adapter for repo-backed scenarios
- [Testing](/help/testing) - running tests and adding QA coverage
- [Matrix](/channels/matrix) - the channel plugin under test
