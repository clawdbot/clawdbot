---
description: Run end-to-end tests against gateway
allowed-tools: Bash(pnpm:*), Read, Grep
argument-hint: [pattern]
success-criteria: |
  - Gateway process spawned (or already running)
  - All E2E tests pass
  - No orphan processes left (gateway killed after tests)
estimated-duration: 3-10 minutes
---

# E2E Tests

Run end-to-end tests for clawdbot.

**Pattern:** $1 (or all E2E tests if not specified)

**Process:**
1. Run `pnpm test:e2e` (optionally filtered by pattern)
2. If tests fail, read the test file and analyze the failure
3. Check if gateway needs to be running for the test

**From .workflow/e2e-testing.md:**
- E2E tests spawn real processes
- Use port polling to wait for services
- Each test has isolated HOME directory
- Extended timeouts for process startup

**Reference tests:**
- `test/gateway.multi.e2e.test.ts` - Multi-message flow patterns

Report detailed results including any stderr output.

## Explore
- E2E tests: `test/**/*.e2e.test.ts`
- Gateway spawning: search for `spawn` in e2e tests
