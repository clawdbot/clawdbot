# Release CI Notes

## What Went Wrong

- Full validation was started before all provider keys were proven valid.
- GitHub secret presence was confused with key validity.
- Repeated `gh run view` and log fetches exhausted REST quota.
- Parent run state was less useful than child run evidence.
- Replacement parent runs were dispatched while an existing parent was still
  recoverable, multiplying polling, cancellation, and identity checks.
- Live-cache failures needed structured classification: invalid key, empty provider output, timeout, or real cache regression.
- Background watchers accumulated and made interruption recovery harder.

## Better Defaults

- Run provider-secret preflight first. Require real `/models` or equivalent endpoint checks for release-blocking providers.
- Keep one watcher open. Use child summaries every few minutes, not every few seconds.
- Fetch failed-job logs only after a job reaches a terminal failing state.
- Prefer same-parent failed-job reruns when the original inputs still select the
  right work.
- Keep one active parent per exact Validation SHA + Tooling SHA + rerun group. Create
  a replacement only when the current evidence is invalid or cannot consume a
  required workflow fix; record the invalidating event and do not widen
  automatically to `rerun_group=all`.
- Classify one failed surface, make one fix when needed, and retry the narrowest
  failed group once. Then reassess whether to ship, explicitly waive, or block
  instead of creating another verification loop.
- Release-check recovery uses one concrete group. The removed `release-checks`
  aggregate handle must never be substituted with `all`.
- Controller recovery uses `qa-parity` or `qa-live`; `qa` is reserved for a
  deliberate direct-child manual aggregate. Filters that do not belong to the
  selected group fail closed.
- Preserve successful exact-tuple evidence when the documented finalization
  rules allow reuse. Narrow evidence does not become publish authorization by
  itself, and there is no standalone rerunnable finalizer today.
- Once a release branch run records its Validation SHA, Tooling SHA, and rerun
  group, later `main` or release-branch movement does not replace any tuple
  member. The frozen candidate may remain behind the release branch only while
  it is still an ancestor; release tags remain exact.
- Leave bad secrets unset. A 401 candidate from 1Password should not overwrite GitHub.
- Make the final release evidence note durable: parent URL, child run URLs, SHA, command proof, and gaps.

## Secret Handling Pattern

- Use `$one-password`; never run broad env dumps.
- Search exact item titles or known ids.
- Validate candidates without printing values.
- Set GitHub secrets only after endpoint validation succeeds.
- After setting, verify metadata with `gh secret list`, not value output.

## Live Cache Pattern

- Empty text with token usage is a provider/output issue until proven otherwise.
- Retry lane-level mismatches once with a fresh session id.
- Keep cache baselines strict, but log enough structured usage to distinguish cache miss from response mismatch.
- If a provider key validates locally but fails in Actions, inspect whether the workflow reads the expected secret name.

## Quota-Safe GitHub Pattern

- Check `gh api rate_limit --jq '.resources.core'` before log-heavy work.
- Use one child-run listing call, then inspect failed jobs only.
- If remaining quota is low, pause until reset; do not keep polling.
- Prefer GraphQL only for metadata when REST is exhausted; logs still need REST.
