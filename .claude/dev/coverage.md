---
description: Analyze test coverage and identify gaps
allowed-tools: Bash(pnpm:*), Read, Glob, Grep
argument-hint: [file-pattern]
---

# Coverage Analysis

Analyze test coverage for the codebase.

**Pattern:** $1 (or full project if not specified)

**Process:**
1. Run `pnpm test:coverage`
2. Parse coverage report for files below 70% threshold
3. Identify:
   - Uncovered lines
   - Uncovered branches
   - Missing test files

**From CLAUDE.md:**
- V8 coverage with 70% thresholds (lines/branches/functions/statements)
- Pure test additions don't need changelog unless they alter user-facing behavior

**Output:**
1. Overall coverage summary
2. Files below threshold (sorted by coverage %)
3. Suggested high-value tests to add

Focus on critical logic paths and error handling branches.
