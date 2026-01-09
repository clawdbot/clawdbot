---
description: Run full quality gate (lint, build, test) before commits
allowed-tools: Bash(pnpm:*)
success-criteria: |
  - lint: No Biome errors
  - build: TypeScript compiles without errors
  - test: All tests pass
estimated-duration: 2-5 minutes
---

# Quality Gate

Run the full quality gate for clawdbot:

```bash
pnpm lint && pnpm build && pnpm test --run
```

Execute each step in sequence. Stop immediately if any step fails.

**From CLAUDE.md:**
- Lint/format via Biome (`pnpm lint`)
- Type-check/build via tsc (`pnpm build`)
- Tests via Vitest with 70% coverage threshold (`pnpm test`)

Report:
1. Status of each gate (pass/fail)
2. If failed: show the specific error
3. If passed: confirm ready for commit

## Explore
- Lint config: `biome.json`
- Build: `tsconfig.json`
