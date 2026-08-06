---
summary: "How Barnacle and ClawSweeper feedback helps move OpenClaw pull requests through review."
read_when:
  - Following up after Barnacle or ClawSweeper feedback
  - Asking ClawSweeper for review
  - Debugging Barnacle, ClawSweeper, stale labels, or auto-closures
title: "Pull request review flow"
sidebarTitle: "PR review flow"
---

This page explains the review flow after you open or update an OpenClaw pull
request: what Barnacle and ClawSweeper do, how to improve the PR from their
feedback, and what to check when automation stays quiet.

Barnacle and ClawSweeper help maintainers keep the review queue usable. They do
not replace maintainer judgment.

## Barnacle

Barnacle is deterministic GitHub triage. It looks for known queue-management
cases and responds with labels, comments, or closures.

Barnacle may act when:

- a PR body is mostly empty or missing problem context;
- a PR has no useful evidence;
- a docs-only, test-only, refactor-only, CI-only, or infra change lacks linked
  maintainer context;
- a change looks like it belongs in ClawHub or a plugin instead of core;
- a branch carries unrelated work;
- an author has more than 20 open PRs.

Barnacle runs from trusted repository workflow code. It does not check out or
run contributor code.

Most routing labels are maintainer or automation signals, so contributors do
not need to add labels themselves.

## ClawSweeper

ClawSweeper is the AI-assisted review and maintenance bot for OpenClaw
repositories. It can review PRs, evaluate proof, leave durable review comments,
and help maintainers with guarded repair or automerge flows.

A positive ClawSweeper result is supporting evidence, not maintainer approval.
Maintainers still decide whether and when a PR is ready to merge.

ClawSweeper is queue-based. Do not expect an immediate response after opening a
PR, pushing a commit, or adding a review request. Label updates after a
ClawSweeper run can also take time.

New PRs enter the ClawSweeper review queue. Maintainers can also queue review,
repair, or automerge flows with labels or commands. For ordinary contributor
updates, ask ClawSweeper for another review only after you have updated the
branch, PR description, proof, or code. Then request a fresh review with a new
PR comment:

```text
@clawsweeper re-review
```

PR authors can also use `@clawsweeper re-run`; users with repository write
access can use either command on any open item. The plain
`@clawsweeper review` command is maintainer-only. Be patient: asking again
before the requested changes are present just adds queue noise.

When ClawSweeper leaves review conversations, treat them like normal review
feedback and use the follow-up checklist below.

If a human contributor or maintainer has taken over the PR and is actively
working on it, do not summon ClawSweeper or otherwise work on the PR at the same
time. Let the human review or repair finish first. If activity stops, check
whether the author was asked to provide proof or make other updates.

## Improve a PR during review

Once Barnacle, ClawSweeper, or a maintainer responds, use that feedback as the
next-step checklist for the PR.

1. Read ClawSweeper's `Rank-up moves:` and `Proof guidance:` as the action list
   for that PR. Ratings and labels are review signals, not fixed merge targets.
2. Push the requested code or docs change, and update the PR description when
   the problem, solution, user impact, or evidence has changed.
3. Add the requested proof, using evidence that matches the change.
4. Resolve addressed review conversations yourself. Reply and leave a
   conversation open only when you need maintainer or reviewer judgment.
5. Ask for a re-review only after the branch, PR description, evidence, and
   relevant CI results are current. Multiple update and review cycles between the
   author, maintainer, and ClawSweeper are normal.
6. Keep discussion on the PR when possible. Move to `#clawtributors` on Discord
   only when the PR needs maintainer coordination, automation appears blocked,
   or the next decision is hard to settle in GitHub comments. Include the PR
   link, current status, and the specific question or remaining evidence.

Keep the PR body current. Comments help with discussion, but the PR
description is the durable summary maintainers and automation revisit.

`status: ⏳ waiting on author` means the next action is with the PR author:
update the branch, PR description, proof, or reply with the missing context
before asking for another review.

Useful evidence includes focused test output, CI results, screenshots,
recordings, terminal output, live observations, redacted logs, or artifact
links. For visual changes, include before and after screenshots when practical.
For proof files, prefer linking CI artifacts, GitHub-uploaded screenshots or
recordings, or a short redacted log excerpt. Do not commit generated proof files
unless they are part of the actual docs, tests, or product change.

Redacting sensitive data is the contributor's responsibility. Remove secrets,
tokens, private URLs, user data, and unrelated logs before posting proof.

OpenClaw also uses separate stale automation. Unassigned issues and PRs can be
marked stale after 14 days of inactivity, then closed after 7 more idle days.
Assigned PRs are marked stale 27 days after opening, regardless of later
updates, then closed after 7 stale days without activity. If an assigned PR is
still active, coordinate with the maintainer working on it.

## When automation stays quiet

Automation may stay quiet when a maintainer is already handling the item, a
review or repair request is still queued, the event is routine, or the
ClawSweeper lane is not configured for the requested action.

It may also avoid action when a trusted workflow would need to run untrusted
contributor code. In that case, maintainers use normal review or a safer
workflow instead.

## Troubleshooting

If ClawSweeper does not respond immediately, wait before retrying. The service is
queue-based, and repeated comments or label changes can make the thread harder
to review without making the queue faster.

Before asking for help, check:

- the PR description is current;
- the latest commit contains the requested change;
- CI has finished, or the PR body explains why any remaining failure is
  unrelated to the PR;
- the latest review request was made as a PR comment:
  `@clawsweeper re-review`;
- a maintainer or contributor is not already actively working on the PR;
- the latest request is not still within the normal ClawSweeper queue delay.

If there is still no ClawSweeper response several hours after the PR is current,
or if the PR appears blocked by automation, ask in `#clawtributors` on Discord.
Include the PR link, what you expected, when you asked, and what changed since
the last bot comment.

## Forking the automation

Projects that want similar review automation can study or fork ClawSweeper:

- [openclaw/clawsweeper](https://github.com/openclaw/clawsweeper)
- [ClawSweeper docs](https://clawsweeper.bot/)

## Related

- [Contributing](https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md)
- [CI pipeline](/ci)
