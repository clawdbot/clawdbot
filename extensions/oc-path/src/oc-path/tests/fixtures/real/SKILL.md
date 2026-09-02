---
name: github
description: Use gh for GitHub issues, PR status, CI/logs, comments, reviews, releases, and API queries.
tier: T1
tools:
  - gh
  - bash
trigger_phrases:
  - github
  - pr
  - issue
  - workflow
metadata: { "openclaw": { "emoji": "🐙", "requires": { "bins": ["gh"] } } }
user-invocable: true
---

# When to use

Use this skill when the user asks anything about GitHub: issues, pull
requests, CI runs, releases, comments, code review, or organizational
metadata. Prefer the `gh` CLI over web URLs — `gh` handles auth,
pagination, and structured output natively.

## Common commands

```bash
gh pr view 123              # view PR details
gh pr checks 123            # CI status
gh issue list --state open  # list open issues
gh run list -L 5            # last 5 workflow runs
gh release create v1.2.3    # cut a release
```

## When NOT to use

- The user's repo is on a non-GitHub forge (GitLab, Gitea, Bitbucket).
  Use the appropriate CLI instead.
- Operations that require admin permissions the agent doesn't have.
