---
name: security-triage
description: Triage GitHub security advisories for OpenClaw with high-confidence close/keep decisions, exact tag and commit verification, trust-model checks, optional hardening notes, and a final reply ready to post and copy to clipboard.
---

# Security Triage

Use when reviewing OpenClaw security advisories, drafts, or GHSA reports.

Goal: high-confidence maintainers' triage without over-closing real issues or shipping unnecessary regressions.

## Close Bar

Close only if one of these is true:

- duplicate of an existing advisory or fixed issue
- invalid against shipped behavior
- out of scope under `SECURITY.md`
- fixed before any affected release/tag

Do not close only because `main` is fixed. If latest shipped tag or npm release is affected, keep it open until released or published with the right status.

## Required Reads

Before answering:

1. Read `SECURITY.md`.
2. Read the GHSA body with `gh api /repos/openclaw/openclaw/security-advisories/<GHSA>`.
3. Inspect the exact implicated code paths.
4. Verify shipped state:
   - `git tag --sort=-creatordate | head`
   - `npm view openclaw version --userconfig "$(mktemp)"`
   - `git tag --contains <fix-commit>`
   - if needed: `git show <tag>:path/to/file`
5. Search for canonical overlap:
   - existing published GHSAs
   - older fixed bugs
   - same trust-model class already covered in `SECURITY.md`

## Review Method

For each advisory, decide:

- `close`
- `keep open`
- `keep open but narrow`

Default to one advisory at a time when comments/closures are involved:

1. Review exactly one GHSA.
2. Print the GHSA URL first.
3. Summarize the decision and evidence for discussion.
4. Draft one maintainer-ready comment.
5. Copy only that one comment to the clipboard.
6. Stop and wait for Peter to post/discuss before moving to the next GHSA.

Do not batch multiple close comments unless Peter explicitly asks for a batch.

Check in this order:

1. Trust model
   - Is the prerequisite already inside trusted host/local/plugin/operator state?
   - Does `SECURITY.md` explicitly call this class out as out of scope or hardening-only?
2. Shipped behavior
   - Is the bug present in the latest shipped tag or npm release?
   - Was it fixed before release?
3. Exploit path
   - Does the report show a real boundary bypass, not just prompt injection, local same-user control, or helper-level semantics?
   - If data only moves between trusted workspace-memory files called out in `SECURITY.md`, do not treat "injection markers" alone as a security bug.
   - In that case, frame sanitization as optional hardening only if it preserves expected memory workflows.
4. Functional tradeoff
   - If a hardening change would reduce intended user functionality, call that out before proposing it.
   - Prefer fixes that preserve user workflows over deny-by-default regressions unless the boundary demands it.
5. Hardening follow-up
   - Even when the GHSA should close, ask whether a narrow hardening change would reduce footguns without changing the documented trust boundary.
   - Separate hardening from vulnerability status. Phrase it as "not required for GHSA closure, but worth considering".
   - Bring up hardening only if it is concrete, low-risk, and preserves intended maintainer/operator workflows.
   - If hardening would require a product/security model change, say that explicitly and do not imply it is a required fix for closure.

## Response Format

When preparing a maintainer-ready close reply:

1. Print the GHSA URL first.
2. Then draft a detailed response the maintainer can post.
3. Include:
   - exact reason for close
   - exact code refs
   - exact shipped tag / release facts
   - exact fix commit or canonical duplicate GHSA when applicable
   - optional hardening note only if worthwhile and functionality-preserving

Keep tone firm, specific, non-defensive.

## Discussion Mode

When Peter is manually posting GHSA comments, use this flow:

1. Show the URL.
2. Give a terse verdict (`close`, `keep open`, or `keep open but narrow`).
3. List the strongest evidence bullets.
4. State any optional hardening follow-up separately from the close reason.
5. Copy the proposed comment body with `pbcopy`.
6. End the reply after the one advisory. Do not continue to the next advisory until Peter says to continue.

If the GitHub API cannot post comments for private advisories, say so once and keep using clipboard/UI paste.

## Clipboard Step

After drafting the final post body for the current advisory, copy it:

```bash
pbcopy <<'EOF'
<final response>
EOF
```

Tell the user that the clipboard now contains the proposed response for that advisory.

## Useful Commands

```bash
gh api /repos/openclaw/openclaw/security-advisories/<GHSA>
gh api /repos/openclaw/openclaw/security-advisories --paginate
git tag --sort=-creatordate | head -n 20
npm view openclaw version --userconfig "$(mktemp)"
git tag --contains <commit>
git show <tag>:<path>
gh search issues --repo openclaw/openclaw --match title,body,comments -- "<terms>"
gh search prs --repo openclaw/openclaw --match title,body,comments -- "<terms>"
```

## Decision Notes

- “fixed on main, unreleased” is usually not a close.
- “needs attacker-controlled trusted local state first” is usually out of scope.
- “same-host same-user process can already read/write local state” is usually out of scope.
- “trusted workspace memory promotes/reindexes trusted workspace memory” is usually out of scope unless it crosses a documented boundary.
- “helper function behaves differently than documented config semantics” is usually invalid.
- If only the severity is wrong but the bug is real, keep it open and narrow the impact in the reply.
