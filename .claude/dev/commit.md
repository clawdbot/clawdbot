---
description: Create a safe, scoped commit using scripts/committer
allowed-tools: Bash(scripts/committer:*), Bash(git status:*), Bash(git diff:*), Bash(git log:*)
argument-hint: "<message>" <file1> [file2...]
success-criteria: |
  - Files staged via scripts/committer
  - Commit created successfully
  - git log -1 shows new commit with correct message
  - Working tree clean for committed files
---

# Safe Commit

Create a commit using the repository's committer script.

**Usage:** `scripts/committer "<message>" <files...>`

**Arguments:** $ARGUMENTS

**Process:**
1. Show `git status` to confirm files to be committed
2. Run `scripts/committer` with the provided message and files
3. Show `git log -1` to confirm the commit

**From CLAUDE.md:**
- Use `scripts/committer` to avoid accidental staging
- Follow concise, action-oriented messages (e.g., "CLI: add verbose flag")
- Group related changes; avoid bundling unrelated refactors

**Examples** (from steipete's commits):
```bash
scripts/committer "fix: retry telegram poll conflicts" src/telegram/polling.ts src/telegram/polling.test.ts
scripts/committer "feat: auto-install gateway in quickstart" src/onboarding/quickstart.ts
```

If no files specified, show git status and list changed files.
