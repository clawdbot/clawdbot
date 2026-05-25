---
name: openclaw-release-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use this with `$openclaw-release-maintainer` and `$openclaw-testing` when a release candidate needs full validation, install/update proof, live provider checks, or CI recovery.

## Guardrails

- No version bump, tag, npm publish, GitHub release, or release promotion without explicit operator approval.
- Validate provider secrets before dispatching expensive full release matrices.
- Do not set GitHub secrets from unvalidated 1Password candidates. If a candidate returns 401/403, leave the existing secret alone and report the exact missing provider.
- Use `$one-password` for secret reads/writes: one persistent tmux session, targeted items only, no secret output.
- Watch one parent run plus compact child summaries. Avoid broad `gh run view` polling loops; REST quota is easy to burn.
- Fetch logs only for failed or currently-blocking jobs. If quota is low, stop polling and wait for reset.
- Treat live-provider flakes separately from code failures: prove key validity, provider HTTP status, retry evidence, and exact failing lane before editing code.

## Preflight

Before full release validation:

```bash
node .agents/skills/openclaw-release-ci/scripts/verify-provider-secrets.mjs --required openai,anthropic,fireworks
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

1Password service-account values are the first source for release provider
preflight. Inject those exact targeted keys first, then run the verifier; use
ambient env only when it was already intentionally injected for this release.
The script prints only provider status and HTTP class, never tokens.

## Dispatch

Start product performance evidence as early as the release SHA exists, in
parallel with other release work:

```bash
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<release-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression=false
```

- Do not wait for full release validation to start this early perf signal.
- Compare available Kova, gateway startup, and CLI startup metrics with earlier
  release evidence or clawgrit reports before publish/closeout.
- Call out any regression in the release proof. Treat a major regression as a
  release blocker until it is fixed, waived by the operator, or proven to be
  infrastructure noise.
- Full Release Validation also records advisory product-performance evidence;
  the early standalone run is for overlap and faster regression discovery.

Prefer the trusted workflow on `main`, target the exact release SHA:

```bash
gh workflow run full-release-validation.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f ref=<release-sha> \
  -f provider=openai \
  -f mode=both \
  -f release_profile=full \
  -f rerun_group=all
```

Use `release_profile=stable` unless the operator explicitly asks for the broad advisory provider/media matrix. Use narrow `rerun_group` after focused fixes.

## Watch

Use the summary helper instead of repeated raw polling:

```bash
node .agents/skills/openclaw-release-ci/scripts/release-ci-summary.mjs <full-release-run-id>
```

Then watch only when useful:

```bash
gh run watch <full-release-run-id> --repo openclaw/openclaw --exit-status
```

Stop watchers before ending the turn or switching strategy.

## Failure Triage

1. Confirm parent SHA and child run IDs.
2. List failed jobs only:
   ```bash
   gh run view <child-run-id> --repo openclaw/openclaw --json jobs \
     --jq '.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | [.databaseId,.name,.conclusion,.url] | @tsv'
   ```
3. Fetch one failed job log. If rate-limited, note reset time and avoid more REST calls.
4. For secret-looking failures, validate the provider endpoint from the same secret source before editing code.
5. For live-cache failures, inspect whether it is missing/invalid key, empty text, provider refusal, timeout, or baseline miss. Do not weaken release gates without clear provider evidence.
6. Fix narrowly, run local/changed proof, commit, push, rerun the smallest matching group.

## Evidence

Record:

- release SHA
- full parent run URL
- child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance
- performance comparison result versus earlier releases when available
- targeted local proof commands
- provider-secret preflight result
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
