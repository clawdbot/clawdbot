## Summary

Describe the problem and fix in 2–5 bullets:

If this PR fixes a plugin beta-release blocker, title it `fix(<plugin-id>): beta blocker - <summary>` and link the matching `Beta blocker: <plugin-name> - <summary>` issue labeled `beta-blocker`. Contributors cannot label PRs, so the title is the PR-side signal for maintainers and automation.

- Problem:
- Why it matters:
- What changed:
- What did NOT change (scope boundary):

## Change Type (select all)

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor required for the fix
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [ ] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [ ] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- Closes #
- Related #
- [ ] This PR fixes a bug or regression

## Real behavior proof (required for external PRs)

External contributors must show after-fix evidence from a real OpenClaw setup. Unit tests, mocks, lint, typechecks, snapshots, and CI are supplemental only. Screenshots are encouraged even for CLI, console, text, or log changes; terminal screenshots and copied live output count. Be mindful of private information like IP addresses, API keys, phone numbers, non-public endpoints, or other private details when providing evidence.

- Behavior or issue addressed:
- Real environment tested:
- Exact steps or command run after this patch:
- Evidence after fix (screenshot, recording, terminal capture, console output, redacted runtime log, linked artifact, or copied live output):
- Observed result after fix:
- What was not tested:
- Before evidence (optional but encouraged):

## Root Cause (if applicable)

For bug fixes or regressions, explain why this happened, not just what changed. Otherwise write `N/A`. If the cause is unclear, write `Unknown`.

- Root cause:
- Missing detection / guardrail:
- Contributing context (if known):

## Regression Test Plan (if applicable)

For bug fixes or regressions, name the smallest reliable test coverage that should catch this. Otherwise write `N/A`.

- Coverage level that should have caught this:
  - [ ] Unit test
  - [ ] Seam / integration test
  - [ ] End-to-end test
  - [ ] Existing coverage already sufficient
- Target test or file:
- Scenario the test should lock in:
- Why this is the smallest reliable guardrail:
- Existing test that already covers this (if any):
- If no new test is added, why not:

## User-visible / Behavior Changes

List user-visible changes (including defaults/config).  
If none, write `None`.

## Diagram (if applicable)

For UI changes or non-trivial logic flows, include a small ASCII diagram reviewers can scan quickly. Otherwise write `N/A`.

```text
Before:
[user action] -> [old state]

After:
[user action] -> [new state] -> [result]
```

## Security Impact (required)

- New permissions/capabilities? (`Yes/No`)
- Secrets/tokens handling changed? (`Yes/No`)
- New/changed network calls? (`Yes/No`)
- Command/tool execution surface changed? (`Yes/No`)
- Data access scope changed? (`Yes/No`)
- If any `Yes`, explain risk + mitigation:

## Repro + Verification

### Environment

- OS:
- Runtime/container:
- Model/provider:
- Integration/channel (if any):
- Relevant config (redacted):

### Steps

1.
2.
3.

### Expected

-

### Actual

-

## Evidence

Attach at least one:

- [ ] Failing test/log before + passing after
- [ ] Trace/log snippets
- [ ] Screenshot/recording
- [ ] Perf numbers (if relevant)

## Human Verification (required)

What you personally verified (not just CI), and how:

- Verified scenarios:
- Edge cases checked:
- What you did **not** verify:

## Review Conversations

- [ ] I replied to or resolved every bot review conversation I addressed in this PR.
- [ ] I left unresolved only the conversations that still need reviewer or maintainer judgment.

If a bot review conversation is addressed by this PR, resolve that conversation yourself. Do not leave bot review conversation cleanup for maintainers.

## Compatibility / Migration

- Backward compatible? (`Yes/No`)
- Config/env changes? (`Yes/No`)
- Migration needed? (`Yes/No`)
- If yes, exact upgrade steps:

## Risks and Mitigations

List only real risks for this PR. Add/remove entries as needed. If none, write `None`.

- Risk:
  - Mitigation:
