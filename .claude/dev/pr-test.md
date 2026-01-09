---
description: Test a PR locally before merging
allowed-tools: Bash, Read, Glob, Grep
argument-hint: <pr-number>
success-criteria: |
  - PR code fetched to temp branch
  - All tests pass
  - E2E tests pass (if applicable)
  - Build succeeds
  - Temp branch cleaned up
---

# Test PR Locally

Test PR #$1 from clawdbot/clawdbot.

## Workflow

### 1. Create Temp Branch
```bash
git checkout -b temp/test-pr-$1 main
```

### 2. Fetch PR Code
```bash
gh pr checkout $1 --repo clawdbot/clawdbot --branch temp/test-pr-$1
```

### 3. Install Dependencies
```bash
pnpm install
```

### 4. Run Quality Gate
```bash
pnpm lint && pnpm build && pnpm test --run
```

### 5. Run E2E Tests (if PR touches gateway/providers)
```bash
pnpm test:e2e
```

### 6. Manual Testing (if applicable)
- Start gateway: `pnpm clawdbot gateway --verbose`
- Test the specific feature/fix mentioned in PR

### 7. Clean Up
```bash
git checkout main
git branch -D temp/test-pr-$1
```

## Report

Provide:
1. **Gate Results**: lint/build/test status
2. **E2E Results**: pass/fail/skipped
3. **Manual Test**: if performed, what was tested
4. **Issues Found**: any problems discovered
5. **Verdict**: WORKS / FAILS / NEEDS CHANGES

If issues found, describe:
- What failed
- Error messages
- Suggested fixes (if obvious)
