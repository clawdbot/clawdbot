---
name: openclaw-live-updater
description: "Maintain the canonical live OpenClaw main checkout, managed Gateway, local macOS app, exact-head main CI, and recurring full release validation. Use for fast-forward update heartbeats, post-update runtime verification, attributable CI repair and repo-native landing, or non-publishing Full Release Validation of current main."
---

# OpenClaw Live Updater

Keep `/Users/steipete/openclaw` a read-only-to-the-agent deployment mirror: clean, standalone, full, on `main`, and fast-forwarded only. Make every repair in the controlling Codex project worktree.

## Boundaries

- Report only in the controlling Codex thread. Never send Slack, Discord, email, or other external messages.
- Never release, tag, bump versions, publish npm, create a GitHub Release, rotate credentials, or weaken a gate.
- Escalate only irreversible or materially risky security, privacy, auth, destructive migration/data-loss, protocol-version, credential-rotation, dependency patch/override, or product choices.
- Diagnose ordinary update, runtime, app, CI, test, and release-validation failures; fix them through a focused PR; prove exact head; land with `scripts/pr`.
- Never edit, stash, reset, clean, or create a branch in the live mirror.

## Fast Update And Maintenance

1. Run the deterministic updater and retain its JSON:

   ```bash
   node .agents/skills/openclaw-live-updater/scripts/update-main.mjs
   ```

   Stop on any failed invariant. Do not repair the mirror destructively. The helper holds one checkout-scoped lock across update, build, Gateway proof, and Mac work. A concurrent heartbeat returns `reason: "overlap"`; it must not start another build. A dead owner lock may be recovered, but unreadable or unsafe lock state fails closed.

2. The helper verifies one unrewritten expected origin, an owned non-symlinked standalone/full clone, single worktree, clean `main`, fetches `origin/main`, rechecks for concurrent changes, and merges `--ff-only`. It then uses the source runner's canonical local-build metadata contract and parser: both `dist/.buildstamp` and `dist/.runtime-postbuildstamp` heads, required runtime-postbuild outputs, `dist/entry.js`, Control UI index plus referenced local assets, and `dist/build-info.json` must all match exact `afterSha`.

   - Every successful update sets `actions.gatewayBuild` and rebuilds exact new `main` before any restart.
   - Missing, invalid, or stale build output also forces a build, even when Git did not move.
   - A dependency-input change, absent `node_modules`, or missing/invalid build provenance requires `pnpm install --frozen-lockfile`. When a build is required, do not install before acquiring the maintenance suspension and stopping the managed Gateway.
   - Before mutating any entrypoint currently executed by the Gateway, invoke an exact trusted source CLI to acquire `gateway.suspend.prepare`, binding both prepare and resume to this checkout's managed LaunchAgent loopback port and service auth even when normal CLI configuration points at a remote Gateway. The LaunchAgent may execute either this checkout's `dist/index.js` or a clean detached canonical snapshot under `~/.openclaw/runtime/gateway-<sha>` whose commit is an ancestor of the checkout; reject every other entrypoint. Never execute snapshot code: capture an exact source control build before the Git fast-forward for its prepare and failure-resume calls, preserve any validated generated service-environment wrapper, and stop the managed LaunchAgent with native launchd bootout. If that control build is missing, first accept native proof that the snapshot job is already booted out with its port free; when the isolated snapshot is still running, build the verified clean source checkout to obtain an exact suspension client, then use only that source client for prepare and failure-resume. Never use this recovery build while launchd targets the source checkout. This atomically pauses cron scheduling, closes new work admission, and refuses while active work remains. A busy result defers further mutation to the next heartbeat; never replace this fence with `cron list` polling. Once ready, stop directly without a source launcher, install frozen dependencies when required, then build unless the exact recovery build already produced the deployment artifact; source launchers can auto-build stale output before dispatching the stop. Resume the suspension if stop fails. If suspension RPC is unavailable on macOS, proceed only when native inspection proves this checkout's managed LaunchAgent is booted out and its configured port has no listener; never accept a loaded KeepAlive job's transient stopped state. On other platforms, require the existing CLI to prove the managed service is stopped with no PID, listener, or RPC. This preserves retry after a post-stop failure without weakening the live-work fence. Preserve `dist/OpenClaw.app` outside `dist` for the build and restore it even when the build fails, because the JS build cleans `dist` regardless of Mac impact classification. Never mutate the live `dist` tree while an old Gateway can dynamically import from it. `pnpm build` must leave both canonical stamp heads and `dist/build-info.json.commit` equal to post-update `afterSha`; any missing/mismatched stamp or required artifact blocks restart.
   - Snapshot ownership validation must never invoke Git inside the snapshot. Treat its worktree, local Git configuration, filters, hooks, attributes, and build artifacts as untrusted; prove only that the regular owned LaunchAgent entrypoint is under the canonical detached ancestor snapshot path. Snapshot validation authorizes native bootout and retargeting only. Every CLI path must reject snapshot execution and use the trusted source checkout build instead.
   - Only after exact-SHA build proof may it restart the managed Gateway and require `gateway status --deep --require-rpc --json` plus `health --verbose --json`. A validated ancestor snapshot is suspension-only: prove the old launchd job is booted out with its port free, allowing bounded retries while launchd and the listener finish teardown, then atomically retarget only the owned LaunchAgent entrypoint to this checkout's exact `dist/index.js`, including on a retry where the build is already current. Replace the verified `ProgramArguments` array as one value; never use array-index plist mutation that can insert a duplicate argument. Preserve all other service arguments and environment unchanged. After restart, prove the loaded launchd PID owns the configured listener.
   - After every managed restart, query Gateway logs through RPC, restrict the audit to entries emitted since that restart began, report warning summaries, and fail the pass on any error/fatal entry. If RPC verification or log retrieval fails, still inspect the local structured log for that restart window. Never accept supervisor or RPC health without this restart-window log audit.

   Treat supervisor state alone as insufficient. If build or proof fails, leave the new mirror head intact and retry the stale/missing build on the next heartbeat; never run the old `dist` against new source.

   Re-run the canonical freshness check immediately before every `pnpm openclaw` restart or probe so the source runner cannot hide stale output with an implicit auto-build. Every pass, including a no-update/current-build pass, must run deep RPC status and verbose health. If that first probe fails while the build is already exact-current, perform one managed Gateway restart and repeat both probes once. Do not rebuild a current exact-SHA artifact merely to self-heal the managed process; fail and diagnose if the one restart does not recover it.

3. If changed paths can affect macOS, the helper runs `scripts/restart-mac.sh --sign --wait --target-only` with `SKIP_TSC=1` and `SKIP_UI_BUILD=1` only after the exact-SHA JS/UI build completes. Reusing those artifacts keeps the live app bundle out of any later JavaScript build cleanup. Target-only mode may stop the canonical `/Applications/OpenClaw.app` process and this checkout's exact `dist` process before launching the rebuilt `dist` app. It defers when another worktree, temporary bundle, test, or agent-owned OpenClaw process is active; it never kills that process. The script's immediate `OK` is not proof. The helper waits and requires the exact executable `/Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw`, then repeats Gateway RPC and health proof.

   Never kill another worktree, temporary bundle, test, or agent-owned OpenClaw process. If a foreign app prevents the exact target from staying alive, record the pending Mac attempt, report it, and retry on the next heartbeat. Escalate only after the conflict persists across repeated heartbeats; never claim Mac proof from another bundle or the short launch check. If `actions.macUiVerification` is true, exercise the changed behavior with the existing macOS/UI automation workflow after delayed exact-bundle proof.

4. Load `$openclaw-testing`. Resolve exact current `origin/main`, then inspect only relevant required checks and workflow jobs whose `headSha` equals it. Ignore skipped jobs and routine noise such as Auto response, Labeler, docs agents, performance advisory jobs, and stale/cancelled runs superseded by a newer run for the same SHA.

5. For an attributable failure, leave the mirror untouched. Use the controlling Codex worktree, trace the failed surface, add focused proof, run `$autoreview`, open a focused PR, and land through `$openclaw-pr-maintainer`'s exact `scripts/pr` sequence. Never weaken or bypass the failing gate. After landing, begin again at step 1 so the mirror, Gateway, app classification, and exact-head checks all converge on new `main`.

If no update, build repair, pending Mac retry, or exact-head failure exists, report a terse no-op with the SHA and proof checked.

## Full Release Validation

Load `$release-openclaw-ci` and `$openclaw-testing`. This is validation only, never release preparation or publication.

1. Treat 12 hours as wall-clock cadence, not per-SHA cadence. Inspect Full Release Validation runs from the last 12 hours and verify effective `release_profile=full`, `rerun_group=all`, and expected child-job shape. Any valid active or successful full/all umbrella in that window satisfies the cadence even if `main` advanced afterward. Never duplicate an active full/all run.
2. Only when the cadence is due, confirm no full/all run is active, then snapshot exact current `origin/main` after checking mirror invariants. Run the provider-secret preflight without printing secrets and dispatch the trusted workflow once:

   ```bash
   gh workflow run full-release-validation.yml \
     --repo openclaw/openclaw \
     --ref main \
     -f ref=<exact-main-sha> \
     -f provider=openai \
     -f mode=both \
     -f release_profile=full \
     -f rerun_group=all
   ```

3. Watch the parent with `release-ci-summary.mjs`; require its recorded target SHA and children to match the dispatch snapshot. Fetch logs only for failed or blocking jobs. Do not cancel unrelated release checks.
4. For a code or harness failure, repair and land from the Codex worktree as above. Then target new exact `main` with the narrowest supported `rerun_group` that covers the failed child; use `live_suite_filter` for one live/E2E shard. A targeted recovery run does not create a second full/all cadence dispatch.
5. Report exact SHA, parent and child run URLs/IDs, conclusions, repairs and landed PRs, targeted reruns, and any genuine proof gap. Do not write release evidence or publish artifacts unless separately authorized.

## Failure Discipline

- Recheck live mirror invariants before every mutation and after every fetch.
- Attribute failures from exact SHA, job, logs, and current source. Provider or infrastructure flakes need independent proof before code edits.
- Keep the task branch focused. No `CHANGELOG.md` change.
- Finish with the mirror clean/on `main`, the Codex worktree clean on the expected branch, remote Testbox stopped, and every public GitHub write linked in the controlling thread.
