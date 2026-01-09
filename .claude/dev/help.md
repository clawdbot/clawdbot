---
description: List available dev workflow commands
---

# Dev Workflow Commands

Available commands in the `dev:` namespace:

## Upstream Contributions
| Command | Description |
|---------|-------------|
| `/dev:fix-issue <number>` | Fix an upstream issue with TDD workflow |
| `/dev:pr-review <number>` | Review a PR (read-only) |
| `/dev:pr-test <number>` | Test a PR locally before merging |

## Quality & Testing
| Command | Description |
|---------|-------------|
| `/dev:gate` | Run full quality gate (lint, build, test) before commits |
| `/dev:test [pattern]` | Run tests with optional pattern filter |
| `/dev:test --coverage` | Run tests with coverage report |
| `/dev:e2e [pattern]` | Run end-to-end tests |
| `/dev:coverage [path]` | Analyze test coverage gaps |

## Workflow
| Command | Description |
|---------|-------------|
| `/dev:tdd red\|green\|refactor` | TDD workflow phases |
| `/dev:commit "msg" files...` | Safe commit using scripts/committer |
| `/dev:docs-review` | Review workflow docs for quality issues |
| `/dev:docs-update` | Review, fix, and commit doc issues |

## Getting Started

**New to this codebase?** Start here:
1. Read `.workflow/AGENTS.md` for complete workflow guide
2. Run `/dev:gate` to verify your setup works
3. Explore `src/**/*.test.ts` for test patterns

**Quick commands:**
```bash
pnpm install        # Install dependencies
pnpm build          # TypeScript compilation
pnpm test           # Run tests
pnpm clawdbot ...   # Run CLI in dev mode
```

**Before committing:** Always run `/dev:gate` first.
