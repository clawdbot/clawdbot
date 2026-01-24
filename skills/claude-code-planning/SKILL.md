---
name: claude-code-planning
description: "AI-to-AI orchestration for Claude Code sessions. Load project context, plan the task, then spawn Claude Code with an enriched prompt."
metadata:
  clawdbot:
    emoji: "🤖"
    requires:
      bins: ["claude"]
---

# Claude Code Planning

Orchestrate Claude Code sessions with AI-to-AI planning.

## Overview

This skill demonstrates the orchestration pattern for Claude Code:

1. Load project context using `project_context` tool
2. Analyze the task and formulate a plan
3. Ask user for clarifications if needed
4. Create an enriched prompt with full context
5. Start Claude Code session using `claude_code_start` tool
6. Answer Claude Code questions autonomously

## Workflow

### Step 1: Load Project Context

```
Use the project_context tool to load context:

{
  "action": "load",
  "project": "<project-name>"
}
```

This returns:
- Project type (React, Node.js, Python, etc.)
- Package manager, test framework, build tool
- Directory structure
- Coding conventions
- CLAUDE.md contents if present

### Step 2: Analyze and Plan

With the context, analyze the user's task:

- What files are likely involved?
- What conventions should be followed?
- Are there any ambiguities to clarify?
- What's the best approach?

### Step 3: Clarify if Needed

If the task is ambiguous, ask the user:

- "Should I use the existing auth pattern or create a new one?"
- "The project uses both Jest and Vitest - which should I use?"
- "Should this be a new component or extend the existing one?"

### Step 4: Create Enriched Prompt

Combine everything into a clear prompt:

```markdown
# Task
<user's original task>

# Project Context
<formatted context from project_context>

# Approach
Based on analysis:
1. <decision 1>
2. <decision 2>

# Instructions
<specific implementation instructions>
```

### Step 5: Start Claude Code

```
Use the claude_code_start tool:

{
  "project": "<project-name>",
  "prompt": "<enriched-prompt>",
  "originalTask": "<user's task>",
  "planningDecisions": ["decision1", "decision2"]
}
```

### Step 6: Monitor and Answer Questions

Claude Code may ask questions during execution. The `onQuestion` callback (if configured) routes these to you for autonomous handling.

## Example Session

**User:** "Add user authentication to the app"

**AI Planning:**
1. Loads project context - React + TypeScript, uses Zustand for state
2. Analyzes - needs auth provider, login/signup forms, protected routes
3. Clarifies - "Should I use JWT tokens or session cookies?"
4. User responds - "JWT please"
5. Creates enriched prompt with all context
6. Starts Claude Code session
7. Answers Claude Code's questions about implementation details

## Best Practices

- Always load context before planning
- Include discovered conventions in the prompt
- Record your decisions for debugging
- Handle questions autonomously when possible
- Update project context with session outcomes

## Related

- [Claude Code Orchestration](/docs/advanced/claude-code-orchestration)
- [Claude Code Tool](/docs/tools/claude-code)
