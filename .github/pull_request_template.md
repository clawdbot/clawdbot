## Summary

What problem does this PR solve?

Why does this matter now?

What is the intended outcome?

What is intentionally out of scope?

What does success look like?

What should reviewers focus on?

<details>
<summary>Summary guidance</summary>

This PR description is the contributor's durable explanation of the change. Write it for human maintainers first; ClawSweeper and Barnacle use the same text to understand intent, proof, risk, and current review state.

Describe the intent and outcome in 2-5 bullets. Avoid restating the diff; reviewers and bots can read the changed files.

If this PR fixes a plugin beta-release blocker, title it `fix(<plugin-id>): beta blocker - <summary>` and link the matching `Beta blocker: <plugin-name> - <summary>` issue labeled `beta-blocker`. Contributors cannot label PRs, so the title is the PR-side signal for maintainers and automation.

</details>

## Linked context

Which issue does this close?

Closes #

Which issues, PRs, or discussions are related?

Related #

Was this requested by a maintainer or owner?

<details>
<summary>Linked context guidance</summary>

Link the issue, PR, discussion, maintainer request, or owner request that explains why this PR should exist. Maintainer context helps reviewers and automation distinguish intended work from drive-by churn.

</details>

## Real behavior proof (required for external PRs)

- Behavior or issue addressed:
- Real environment tested:
- Exact steps or command run after this patch:
- Evidence after fix (screenshot, recording, terminal capture, console output, redacted runtime log, linked artifact, or copied live output):
- Observed result after fix:
- What was not tested:
- Proof limitations or environment constraints:
- Before evidence (optional but encouraged):

<details>
<summary>Real behavior proof guidance</summary>

External contributors must show after-fix evidence from a real OpenClaw setup. Unit tests, mocks, lint, typechecks, snapshots, and CI are supplemental only.

Screenshots are encouraged even for CLI, console, text, or log changes. Terminal screenshots, copied live output, redacted runtime logs, recordings, and linked artifacts count.

If your environment cannot produce the ideal proof, explain that under `Proof limitations or environment constraints` so reviewers and ClawSweeper can direct the next step properly.

Be mindful of private information like IP addresses, API keys, phone numbers, non-public endpoints, or other private details when providing evidence.

</details>

## Tests and validation

Which commands did you run?

What regression coverage was added or updated?

What failed before this fix, if known?

If no test was added, why not?

<details>
<summary>Testing guidance</summary>

List focused commands, not every incidental check. CI is useful support, but external PRs still need real behavior proof above when behavior changes.

</details>

## Risk checklist

Did user-visible behavior change? (`Yes/No`)

Did config, environment, or migration behavior change? (`Yes/No`)

Did security, auth, secrets, network, or tool execution behavior change? (`Yes/No`)

What is the highest-risk area?

How is that risk mitigated?

<details>
<summary>Risk guidance</summary>

Use this for author judgment that is not obvious from the diff. ClawSweeper can see touched files, but it cannot know which behavior you think is risky, why the risk is acceptable, or what mitigation reviewers should verify.

</details>

## Current review state

What is the next action?

What is still waiting on author, maintainer, CI, or external proof?

Which bot or reviewer comments were addressed?

<details>
<summary>Review state guidance</summary>

Keep this as the durable state for review progress. If useful information appears in comments, fold the current next action or blocker back here so maintainers and ClawSweeper do not need to reconstruct state from comment history.

</details>
