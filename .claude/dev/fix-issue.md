---
description: Fix an upstream issue with TDD workflow
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task
argument-hint: <issue-number> [context]
success-criteria: |
  - Test proving the fix exists
  - Implementation passes all tests
  - /dev:gate passes
  - CHANGELOG entry added
  - Commit ready for PR
---

# Fix Upstream Issue

Fix issue #$1 from clawdbot/clawdbot.

**Additional context:** $2

## Workflow

### 1. Understand the Issue
- Fetch issue details: `gh issue view $1 --repo clawdbot/clawdbot`
- Read related code to understand the problem
- Identify the root cause

### 2. Write Failing Test (TDD Red)
- Create test that reproduces the bug
- Run `pnpm test --run` - confirm it FAILS
- Test should prove the fix works when green

### 3. Implement Fix (TDD Green)
- Write MINIMAL code to pass the test
- Run `pnpm test --run` until green
- Keep changes focused - fix only this issue

### 4. Quality Gate
- Run `/dev:gate` (lint, build, test)
- Fix any issues before proceeding

### 5. Prepare for PR
- Add CHANGELOG entry: `- Area: description. (#$1)`
- Commit with: `scripts/committer "fix: description (#$1)" <files>`

## Git Workflow

```bash
# If not on a PR branch yet:
git fetch upstream
git checkout -b pr/fix-issue-$1 upstream/main
```

## Deliverables
Report:
1. Root cause identified
2. Test file and case added
3. Implementation summary
4. Gate status (pass/fail)
5. Files ready to commit

## Constraints
- One fix per issue - no unrelated changes
- Follow existing code patterns
- Keep under 100 lines changed if possible
