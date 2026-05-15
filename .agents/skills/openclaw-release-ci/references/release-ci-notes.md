# Release CI Notes

## What Went Wrong

- Full validation was started before all provider keys were proven valid.
- GitHub secret presence was confused with key validity.
- Repeated `gh run view` and log fetches exhausted REST quota.
- Parent run state was less useful than child run evidence.
- Live-cache failures needed structured classification: invalid key, empty provider output, timeout, or real cache regression.
- Background watchers accumulated and made interruption recovery harder.

## Better Defaults

- Run provider-secret preflight first. Require real `/models` or equivalent endpoint checks for release-blocking providers.
- Keep one watcher open. Use child summaries every few minutes, not every few seconds.
- Fetch failed-job logs only after a job reaches a terminal failing state.
- Prefer narrow `rerun_group` recovery after a focused fix.
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
