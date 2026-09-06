# Author and regression attribution

Read this when the user asks who wrote something, when contributor identity or
history matters to a concrete trust decision, or when assigning a regression to
an introducing commit. Ordinary review needs contributor identity and preserved
credit, not a contribution-history investigation.

## Contributor context

Use the verified PR/issue author login, not the chat user's name. Fetch profile
metadata once if useful:

```bash
gh api users/<login> --jq '{login,name,created_at,type}'
.agents/skills/openclaw-pr-maintainer/scripts/github-activity.sh <login>
```

Add `--global` only when GitHub-wide activity is relevant. The helper uses up to
five calls per person with global activity enabled; do not run it for every item
by default. Use native caching and separate repository totals from contribution
graph totals with their actual intervals. Missing, incomplete, cached, or failed
queries are not zero activity; private visibility may affect totals. Activity is
context, not evidence that a patch is correct or incorrect.

Use a public author email from the PR commit, or its GitHub noreply identity,
when preserving real contributor credit. Never invent a name or email.

## Introducing-commit claims

`git log -S/-G`, blame, and linked PRs find candidates; they do not prove who
introduced the defect. Inspect raw parents and compare the implicated behavior:

```bash
git --no-replace-objects cat-file -p <candidate-sha>
git --no-replace-objects diff --no-ext-diff --no-textconv \
  <raw-parent> <candidate-sha> -- <path>
```

A shallow/grafted boundary is not a root commit. Missing parent objects or an
unverifiable patch means unknown attribution, not an invented introducing SHA.
Use before/after behavior proof when feasible. Unknown history does not invalidate
an independently demonstrated current defect.

Distinguish code author, PR author, merger, committer, automation trigger, and
current PR owner. Attribute automation to a human only from verified timeline or
command evidence. Report confidence and the narrow claim the evidence supports;
do not infer introduction from dates, roles, or a maintainer's involvement.
