---
description: Review a PR from upstream (read-only)
allowed-tools: Bash(gh:*), Read, Glob, Grep, WebFetch
argument-hint: <pr-number>
success-criteria: |
  - Security review completed
  - Code quality assessed
  - Test coverage evaluated
  - CHANGELOG entry verified
  - Clear approve/request-changes recommendation
---

# PR Review

Review PR #$1 from clawdbot/clawdbot.

**IMPORTANT: Read-only review. Do NOT checkout the branch or modify any code.**

## Workflow

### 1. Fetch PR Details
```bash
gh pr view $1 --repo clawdbot/clawdbot
gh pr diff $1 --repo clawdbot/clawdbot
```

### 2. Review Checklist

**Security:**
- [ ] Input validation on user data
- [ ] No injection vulnerabilities (SQL, command, XSS)
- [ ] No secrets/credentials in code
- [ ] Safe file operations

**Code Quality:**
- [ ] Error handling for edge cases
- [ ] Type safety (no `any` unless justified)
- [ ] Follows existing patterns in codebase
- [ ] Files under ~700 LOC

**Style:**
- [ ] No over-engineering
- [ ] No unrelated refactoring bundled in
- [ ] Clear naming and structure

**Tests:**
- [ ] New/changed behavior has tests
- [ ] Tests are meaningful (not just coverage padding)
- [ ] Edge cases covered

**Documentation:**
- [ ] CHANGELOG entry with PR # exists
- [ ] Contributor thanked if external
- [ ] Code comments for non-obvious logic

### 3. Summarize Findings

Report:
1. **Summary**: What this PR does
2. **Security**: Any concerns? (critical/none)
3. **Quality**: Issues found (high/medium/low/none)
4. **Tests**: Adequate coverage? (yes/no/partial)
5. **CHANGELOG**: Present and correct? (yes/no/needs update)
6. **Recommendation**: APPROVE / REQUEST CHANGES / COMMENT

If requesting changes, list specific items to address.
