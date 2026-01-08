# Agent Workflow (Local)

This doc covers dev-specific workflow. For coding standards, see root `CLAUDE.md`.

## Git Remotes

| Remote | Repository | Purpose |
|--------|------------|---------|
| `dev` | petter-b/clawdbot-dev (private) | Daily development |
| `fork` | petter-b/clawdbot (public) | PR staging, mirrors upstream |
| `upstream` | clawdbot/clawdbot | PR target only, never push directly |

## Dev-Only Files

These files exist only in `dev`, never pushed to `fork` or `upstream`:

```
.workflow/           # Dev workflow docs (this file!)
.claude/             # Claude Code config (slash commands, hooks, settings)
scripts/setup-*.sh   # Local setup scripts
```

## Syncing from Upstream

Keep all remotes in sync when upstream changes:

```bash
# Fetch and merge upstream
git fetch upstream
git checkout main
git merge upstream/main

# Push to both remotes
git push dev main
git push fork main
```

## Preparing a PR

When work is ready for upstream submission:

```bash
# 1. Create a clean branch from upstream/main
git fetch upstream
git checkout -b pr/feature-name upstream/main

# 2. Cherry-pick or squash your commits
#    Option A: Cherry-pick specific commits
git cherry-pick <commit1> <commit2>

#    Option B: Squash merge from your dev branch
git merge --squash dev-branch-name
git commit -m "feat: description of changes"

# 3. Verify no dev-only files are included
git diff --name-only upstream/main
#    Should NOT include: .workflow/, .claude/, etc.

# 4. Push to fork (not dev!)
git push fork pr/feature-name

# 5. Create PR
gh pr create --repo clawdbot/clawdbot \
  --base main \
  --head petter-b:pr/feature-name \
  --title "feat: description" \
  --body "Description of changes"
```

## Quick Reference

| Task | Command |
|------|---------|
| Sync from upstream | `git fetch upstream && git merge upstream/main` |
| Push to dev | `git push dev <branch>` |
| Push to fork (PR-ready) | `git push fork <branch>` |
| Create PR | `gh pr create --repo clawdbot/clawdbot` |

## Multi-Agent Safety

Agents use git worktrees (`.worktrees/`). Rules:
- Don't switch branches
- Don't stash
- Don't force push
- Each agent gets its own worktree

## Where to Find Things

- Coding standards: `CLAUDE.md` (root)
- Test patterns: explore `src/**/*.test.ts`
- CLI commands: `package.json` scripts
- Slash commands: `.claude/commands/`
