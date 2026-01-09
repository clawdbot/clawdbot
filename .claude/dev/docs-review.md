---
description: Review workflow docs for quality issues
allowed-tools: Task, Read, Glob, Grep
argument-hint: [path]
success-criteria: |
  - Both sub-agent reviews completed
  - Issues listed with file:line references
  - Each issue has suggested fix
  - "DOCUMENTATION IS READY" if no issues found
---

# Documentation Review

Review `.workflow/` and `.claude/` docs using two specialized sub-agents in parallel.

**Path:** $1 (or all workflow docs if not specified)

## Process

Spawn TWO agents in parallel (single message with multiple Task calls):

### 1. Claude Code Guide Agent

```
subagent_type: claude-code-guide

Review the workflow documentation in this repo for Claude Code best practices.

First, discover all relevant files:
- Glob for .claude/**/* (md, json, sh)
- Glob for .workflow/**/*

Then check for:
- Correct Claude Code feature usage (hooks, slash commands, settings)
- Valid tool names in allowed-tools
- Proper subagent_type references
- Hook configuration accuracy
- Slash command syntax and patterns

Report issues as:
## Claude Code Issues
### [severity] file:line
Description
**Fix:** suggestion
```

### 2. Clawdbot Guide Agent

```
subagent_type: clawdbot-guide

Review the workflow documentation for Clawdbot accuracy.

First, discover all relevant files:
- Glob for .workflow/**/*

Then check for:
- Correct test patterns and helpers referenced
- Valid file paths (src/ structure exists)
- Accurate CLI commands and flags
- E2E patterns match actual codebase
- CHANGELOG format matches repo conventions

Report issues as:
## Clawdbot Issues
### [severity] file:line
Description
**Fix:** suggestion
```

## Combine Results

After both agents complete, combine their findings:

```
## Documentation Review Summary

### Claude Code Issues
(from claude-code-guide agent)

### Clawdbot Issues
(from clawdbot-guide agent)

---
DOCUMENTATION IS READY FOR PRODUCTION USE (if no issues from either agent)
```
