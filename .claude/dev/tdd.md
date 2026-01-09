---
description: TDD workflow - write tests first, then implement
allowed-tools: Bash(pnpm:*), Read, Write, Edit, Glob, Grep
argument-hint: <phase> [feature-description]
success-criteria: |
  - red: Tests written and confirmed FAILING
  - green: All tests PASSING
  - refactor: Tests still passing, code improved
---

# TDD Workflow

Follow Test-Driven Development for the specified feature.

**Phase:** $1 (red | green | refactor)
**Feature:** $2

## Phases

### red - Write Failing Tests
1. Explore `src/**/*.test.ts` for existing patterns
2. Create test file following `<feature>.test.ts` naming
3. Write comprehensive test cases (expected inputs/outputs)
4. Run `pnpm test --run` - confirm tests FAIL
5. Do NOT write implementation yet

### green - Make Tests Pass
1. Read the test file to understand requirements
2. Write MINIMAL code to pass all tests
3. Run `pnpm test --run` repeatedly until green
4. Do NOT refactor or add extra features

### refactor - Improve Code
1. All tests must be green first
2. Improve code structure, naming, DRY
3. Run `pnpm test --run` after each change
4. Run `pnpm lint` to check style
5. Keep tests passing throughout

**From CLAUDE.md:**
- Aim for 70% coverage
- Keep files under ~700 LOC
- Extract helpers instead of "V2" copies

Report which phase completed and next steps.

## Explore
- Existing tests: `src/**/*.test.ts`
- Test helpers: search for `describe(` patterns
