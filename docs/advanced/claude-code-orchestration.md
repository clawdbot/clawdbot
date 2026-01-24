---
summary: "AI-to-AI orchestration pattern for Claude Code sessions"
read_when:
  - Building AI agents that spawn Claude Code
  - Implementing custom Claude Code integrations
  - Understanding the planning + execution workflow
---

# Claude Code Orchestration Pattern

This document describes the AI-to-AI orchestration pattern for Claude Code sessions, allowing an AI agent to plan, enrich, and spawn Claude Code sessions on behalf of users.

## Overview

The orchestration pattern enables an AI agent to:

1. **Load project context** - Understand the project before starting
2. **Plan the task** - Analyze requirements, ask clarifications
3. **Enrich the prompt** - Add context, conventions, decisions
4. **Start Claude Code** - Spawn session with enriched prompt
5. **Route questions** - Answer Claude Code questions on behalf of user

## Core Tools

### `project_context`

Load and cache project context for planning:

```typescript
import { createProjectContextTool } from "./agents/tools/project-context-tool.js";

const tool = createProjectContextTool({
  projectsBase: "/path/to/context/storage",
  projectDirs: ["/home/user/projects"],
});

// Actions: load, explore, update, list, format
```

**Actions:**
- `load` - Get cached context (explores if missing/stale)
- `explore` - Force re-exploration
- `update` - Add preferences or session summaries
- `list` - List all cached projects
- `format` - Get markdown for prompt inclusion

### `claude_code_start`

Start a Claude Code session with callbacks:

```typescript
import { createClaudeCodeStartTool } from "./agents/tools/claude-code-start-tool.js";

const tool = createClaudeCodeStartTool({
  onSessionStart: (sessionId, metadata) => {
    console.log(`Session ${sessionId} started for ${metadata.projectName}`);
  },
  onStateChange: (sessionId, state) => {
    console.log(`Session ${sessionId}: ${state.status}`);
  },
  onQuestion: async (sessionId, question, metadata) => {
    // Route to orchestrator AI or human
    return await getAnswer(question, metadata);
  },
});
```

## Workflow Example

```typescript
// 1. Load project context
const context = await projectContextTool.execute({
  action: "load",
  project: "my-project",
});

// 2. AI analyzes task with context
const enrichedPrompt = `
# Task
${originalTask}

# Project Context
${context.formatted}

# Approach
Based on analysis, implement this by:
1. ${decision1}
2. ${decision2}
`;

// 3. Start Claude Code session
const result = await claudeCodeStartTool.execute({
  project: "my-project",
  prompt: enrichedPrompt,
  originalTask,
  planningDecisions: [decision1, decision2],
});

// 4. Questions from Claude Code are routed to onQuestion callback
```

## Integration Points

### Telegram/Discord Integration

```typescript
const tool = createClaudeCodeStartTool({
  onSessionStart: (sessionId, metadata) => {
    // Create status bubble/embed
    createSessionBubble(sessionId, metadata);
  },
  onStateChange: (sessionId, state) => {
    // Update bubble with progress
    updateSessionBubble(sessionId, state);
  },
  onQuestion: async (sessionId, question) => {
    // Route to orchestrator AI
    return await aiOrchestrator.answer(question);
  },
});
```

### Custom Project Resolution

```typescript
const tool = createClaudeCodeStartTool({
  projectResolver: (projectName) => {
    // Custom logic to resolve project names
    if (projectName === "acme") {
      return "/work/clients/acme/main";
    }
    return undefined; // Fall back to default
  },
});
```

## Configuration

### Project Context Storage

Context is cached in YAML files:

```
~/clawd/projects/
├── project-name/
│   └── context.yaml
└── another-project/
    └── context.yaml
```

Configure the location:

```typescript
import { setProjectsBase } from "./agents/claude-code/project-context.js";
setProjectsBase("/custom/path");
```

### Project Discovery

Projects are discovered from:

1. Explicit aliases in config (`claudeCode.projects`)
2. Directories listed in config (`claudeCode.projectDirs`)
3. Default directories (`~/clawd/projects`, `~/projects`, etc.)

## Session State

The `SessionState` object provides:

```typescript
interface SessionState {
  status: "starting" | "running" | "waiting_for_input" | "completed" | ...;
  projectName: string;
  resumeToken: string;
  runtimeStr: string;      // "0h 12m"
  phaseStatus: string;     // Current phase
  branch: string;          // Git branch
  recentActions: Action[]; // Latest tool uses
  hasQuestion: boolean;    // Waiting for input?
  questionText: string;    // The question
}
```

## Best Practices

1. **Always load context first** - Understand the project before planning
2. **Enrich prompts** - Include conventions, preferences, decisions
3. **Track decisions** - Pass `planningDecisions` for debugging
4. **Handle questions** - Implement `onQuestion` for autonomous operation
5. **Update context** - Record session outcomes for learning

## Credits

This orchestration pattern draws inspiration from [Takopi](https://github.com/banteg/takopi) by [@banteg](https://github.com/banteg) - a brilliant Telegram bridge for Claude Code with project management and session resumption.

Key concepts adapted from Takopi:
- AI-to-AI planning orchestration
- Project context loading before sessions
- Progress tracking across sessions
- Session resume and continuation

For a Python-based Telegram bridge focused specifically on coding agents, check out Takopi!
