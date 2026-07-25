# Auto QA evidence ledger

Maintain one Markdown ledger in the user-requested report. Resume its existing numbering; never replace, reset, or inflate a running campaign.

Record campaign-wide facts:

- The operator's current requested target and minimum soak duration; update the active target without erasing earlier historical progress.
- Exact current `origin/main` SHA and refresh time.
- The single refresh coordinator; native-operation pauses and proof that each post-merge fetched baseline contains the recorded merge SHA.
- At least ten named, meaningfully distinct active subsystem lanes.
- Owned gateway ports, isolated state, health, CPU/memory/load, and remote lease state.
- Actual live provider and selected model without credential material.
- Soak start, elapsed time, pass/fail/skip counts, and whether completion was actually reached.
- Both current author-limit workflows, complete author count, and actual author, repository-role, bot/app, branch-prefix, or override exemption, if one is proved.

For each candidate use one explicit state:

- **Hypothesis:** worker reported a potential issue; no independent reproduction.
- **Reproduced:** failing current-main user path or focused regression established.
- **Fix validated:** the canonical-owner root-cause refactor passes relevant user-path, sibling regressions, independent review, and required exact-head checks.
- **Review required:** large, sensitive, uncertain, compatibility-affecting, or explicitly owner-reviewed work; link the separate PR without counting it.
- **Merged:** exact hosted checks passed, native maintainer landing succeeded, and canonical main contains the merge SHA.
- **Rejected or duplicate:** record the actual reason and canonical root cause; do not increment progress.

For every accepted merge include:

```text
<number>/<target>: <distinct user-visible bug>
subsystem: <canonical owner and affected user surface>
main baseline: <full SHA>
root cause: <repo-root source paths and current behavior>
canonical refactor: <owner, shared invariant, affected callers and siblings>
before: <actual failing user repro or regression>
after: <exact passing product path and focused regression>
live proof: <model, nonzero scenario/test counts, or exact packaging proof>
review: <fresh independent review on final head>
CI: <exact head and successful required run or check>
PR: <canonical GitHub pull request URL>
merged main SHA: <verified canonical full SHA>
risk: low; autonomous landing explicitly authorized
```

Do not accept a symptom-only guard, one-sided workaround, compatibility shim, duplicate count, mere workflow dispatch, queued CI, old-head success, a green summary with zero executed scenarios, mocked model responses, stale screenshots, a test skipped for missing credentials, or a GitHub merge request without verified canonical main state. Stop the count at the actual number of verified root-cause merges; never round up toward the user-requested target.
