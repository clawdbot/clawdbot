---
name: github-pr
description: Fetch, preview, merge, and test GitHub PRs locally. Great for trying upstream PRs before they're merged.
homepage: https://cli.github.com
metadata:
  clawdhub:
    emoji: "🔀"
    requires:
      bins: ["gh", "git"]
---

# GitHub PR Tool

Fetch and merge GitHub pull requests into your local branch. Perfect for:
- Trying upstream PRs before they're merged
- Incorporating features from open PRs into your fork
- Testing PR compatibility locally

## Prerequisites

- `gh` CLI authenticated (`gh auth login`)
- Git repository with remotes configured

## Commands

### Preview a PR
```bash
github-pr preview <owner/repo> <pr-number>
```
Shows PR title, author, status, files changed, CI status, and recent comments.

### Fetch PR branch locally
```bash
github-pr fetch <owner/repo> <pr-number> [--branch <name>]
```
Fetches the PR head into a local branch (default: `pr/<number>`).

### Merge PR into current branch
```bash
github-pr merge <owner/repo> <pr-number> [--no-install]
```
Fetches and merges the PR. Optionally runs install after merge.

### Full test cycle
```bash
github-pr test <owner/repo> <pr-number>
```
Fetches, merges, installs dependencies, and runs build + tests.

## Examples

```bash
# Preview MS Teams PR from clawdbot
github-pr preview clawdbot/clawdbot 404

# Fetch it locally
github-pr fetch clawdbot/clawdbot 404

# Merge into your current branch
github-pr merge clawdbot/clawdbot 404

# Or do the full test cycle
github-pr test clawdbot/clawdbot 404
```

## Notes

- PRs are fetched from the `upstream` remote by default
- Use `--remote <name>` to specify a different remote
- Merge conflicts must be resolved manually
- The `test` command auto-detects package manager (npm/pnpm/yarn/bun)
