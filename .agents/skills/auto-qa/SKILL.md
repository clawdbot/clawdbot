---
name: auto-qa
description: "Continuously audit, live-test, and stress-test the current OpenClaw codebase across at least ten independently scoped subsystem lanes; reproduce and deduplicate genuine bugs, verify focused fixes, maintain an evidence-backed report, and prepare or land pull requests according to maintainer authorization and risk. Use for OpenClaw-wide autonomous QA, live-provider campaigns, gateway, CLI, web, plugin, native-app, scenario, packaging, and extended soak testing."
---

# OpenClaw Auto QA

Run a continuous, current-`main` OpenClaw product campaign. Treat a reviewer finding as a hypothesis, a passing test as evidence only for its actual head, and a merge as complete only when the canonical repository confirms it.

## Start with the moving source

1. Read all of root `AGENTS.md`, then each scoped guide for the lanes under inspection. Read the current skill for a specialized workflow instead of reproducing stale instructions:
   - `$openclaw-landable-bug-sweep` for bug acceptance and duplicate handling.
   - `$openclaw-testing` for actual test and CI selection.
   - `$openclaw-qa-testing` for QA Lab, scenario catalogs, and real provider lanes.
   - `$control-ui-e2e` for browser and Control UI proof.
   - `$crabbox` for remote, Docker, packaged, cross-platform, and live proof.
   - `$autoreview` for fresh independent review before publishing or landing.
   - `$openclaw-pr-maintainer` for authorized maintainer-side GitHub actions.
2. Check `git status -sb`. When network access is authorized, refresh with `git fetch origin main`; record the full `origin/main` SHA and inspect the current source, package scripts, scenario inventory, workflows, and scoped guides at that SHA. For an explicitly offline or read-only assignment, record the existing remote-tracking SHA and disclose that remote freshness is unverified; never fetch or contact a provider without authorization. Never pull, rebase, or switch a checkout that another agent is using.
3. Make one requested, fresh `codex/` worktree per implementation task. Keep reviewer workers read-only. When network access is authorized, refresh `origin/main` periodically and recreate or revalidate candidates against the new head. Otherwise revalidate against the locally recorded remote-tracking SHA and explicitly report that remote freshness is unverified.
4. Initialize or resume the user-requested Markdown report and numbered ledger. Read [references/campaign-evidence.md](references/campaign-evidence.md) and [references/evidence-ledger.md](references/evidence-ledger.md) before accepting a finding.

## Keep at least ten lanes active

When independent worker execution is authorized, keep **at least ten materially different subsystem investigations** in flight throughout the active campaign. Replace completed, failed, or stale workers promptly. Network authorization separately determines whether a lane may fetch, invoke an externally hosted model, or contact a provider; it does not prohibit authorized local subagents. If independent workers are unavailable or forbidden, record the concurrency requirement as blocked rather than claiming sequential reviews are concurrent. Start with the OpenClaw-specific lane map in [references/subsystem-lanes.md](references/subsystem-lanes.md). Split a large area into narrow, independent ownership surfaces instead of giving one worker the entire gateway, provider, UI, or app tree.

Use first-class subagents when available and bounded `codex exec --sandbox read-only --ephemeral` reviewers when agent slots are exhausted; verify the installed CLI's supported options with `codex exec --help`. Give each worker the frozen main SHA, one subsystem and its scoped guide, a bounded duration, and the required evidence shape. Ask for source, at least one caller and callee, sibling behavior, regression tests, current-main reproduction, upstream dependency proof when relevant, severity, and duplicate references. Do not disclose a proposed diagnosis to an independent verifier. When the assignment forbids external model calls or independent workers, inspect ten subsystem slices locally, report the actual concurrency as blocked, and never represent sequential inspection as ten active lanes.

Observe CPU, memory pressure, disk, open ports, actual worker count, and gateway health between waves. Scale to the machine and operator-authorized load rather than mechanically starting 64 workers or treating a brief load-average spike as failure. Reduce campaign concurrency for sustained memory pressure, gateway failures, process starvation, or an actual operator limit. Keep remote proofs serialized per Testbox lease; never reclaim, sync, or launch another command while that lease has an active command. When a local process session disappears, recover the authoritative remote job and exact exit before retrying or claiming a pass. Use bounded retries and timeouts. Stop only campaign-owned processes.

## Prove actual product behavior

Read [references/live-proof-routing.md](references/live-proof-routing.md) before invoking a provider, private QA build, remote lease, packaged install, or native app.

- Use isolated campaign state and free localhost ports for dev gateways. Never stop, restart, reconfigure, migrate, or bind the operator's running gateway, app, device, state directory, or default gateway port.
- Classify source trust before execution. Do not execute untrusted contributor scripts, hooks, configuration, tests, or package installation on a local or credential-hydrated machine.
- Use the existing service-account or provider credential only through the approved secret-backed workflow. Never print, log, commit, echo, export into an untrusted worker, or include credentials in test artifacts.
- For an OpenAI claim, assert the actual configured `openai/<model>`, a real model response, and the requested tool, file, image, streaming, or subagent behavior. An unavailable provider, mock, skipped test, fallback response, or an earlier head is not live proof.
- Derive QA scenario IDs from current `qa/scenarios/index.yaml` and scenario YAML. Inspect the actual harness and generated summary. Count a scenario only when the requested run reports a nonzero total, zero failures, and the exact model, provider mode, and relevant behavior.
- Cap an individual live subagent-fanout scenario at 780 seconds after startup. Separately verify setup, timeout recovery, the original parent, child completion, and the final nonzero scenario result.
- For installed-package or plugin bugs, run the real current packaging and user install/update path. Unit tests alone do not prove a built distribution, npm package, Docker image, or Git plugin.
- Test iOS, Android, and macOS only where the current host, device, simulator, signing identity, emulator, or hosted proof actually supports the operation. Record unavailable prerequisites rather than manufacturing mobile or UI coverage.
- Bound stress and soak tests, record exact start time and successful/failed/skipped counts, and continue observing system health. Never describe a ten-hour soak as complete before ten actual elapsed hours.

## Turn findings into verified fixes

1. Deduplicate against the current ledger, `origin/main`, current open and merged GitHub work, and sibling root causes. Do not count the same defect once per model, platform, route, symptom, test, or PR.
2. Have an independent worker validate the reported behavior from the current source and user path. Add a focused regression that fails before the repair and passes after it when practical.
3. Fix the canonical owner in an isolated worktree. Preserve public configuration, plugin ownership, gateway protocol, migration, provider, and external dependency contracts. Avoid new options, speculative compatibility, parallel state formats, dependency changes, or hard-coded symptoms.
4. Run appropriately scoped proof on the exact candidate head. Route Docker, live providers, packaging, full checks, typechecking, broad suites, and browser work through the appropriate existing remote workflow. Inspect real exit status, scenario counts, and artifacts.
5. Run a fresh `$autoreview` on the complete final diff. Resolve actionable findings; rerun it after any production, test, or head change. Verify formatting, `git diff --check`, exact-head CI, and the latest ClawSweeper rank-up moves.
6. Create a focused PR with the repository's actual template, repro, user impact, frozen head, proof, and risk. Use only the current repo-native `scripts/pr` review, artifact, prepare, and merge workflow for authorized main landing.
7. Autonomously merge only when the user authorized it **and** the defect is individually reproduced, small, low-risk, independently reviewed, current-main-compatible, and has green required exact-head proof. Verify the resulting canonical merge SHA before incrementing the ledger.

Prepare but **do not autonomously merge** security or authentication changes; SQLite integrity, migration, schema, or persistent-state changes; public configuration or plugin SDK compatibility changes; protocol changes; architectural refactors; product decisions; broad fixes; uncertain diagnoses; or a candidate with pending, skipped, stale, conflicting, or failing proof. Mark these **user review required** and keep them outside the accepted-bug count.

## Maintain accurate campaign state

Update the requested report throughout the campaign, not only at the end. Follow [references/campaign-evidence.md](references/campaign-evidence.md) for campaign and active-lane evidence and [references/evidence-ledger.md](references/evidence-ledger.md) for verified bug states. Separate discovered hypotheses, reproduced bugs, review-required PRs, exact-head validated fixes, and actually merged fixes. Report the frozen main SHA, worker lanes, resource use, live model and gateway proof, soak timestamps, actual failures, independent review, CI run IDs, PR links, and canonical merge SHAs.

Count only distinct, verified, authorized, **actually merged** low-risk bugs toward an explicit target. Never count the Auto QA skill PR, observations, pending PRs, skipped checks, existing unrelated merges, hypotheses, or review-required fixes. Keep iterating on this skill from real campaign evidence in a separate skill-only worktree and PR.
