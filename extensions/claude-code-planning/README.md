# Claude Code Planning Plugin

AI-to-AI orchestration for Claude Code sessions.

## Overview

This plugin provides tools for agents to:
- **Load and cache project context** - Understand project structure, conventions, and preferences
- **Start Claude Code sessions** - Spawn enriched Claude Code sessions with full context

## Phase 1 (Current)

Core plugin functionality without Telegram integration.

## Installation

```bash
# From npm (once published)
clawdbot plugins install @clawdbot/claude-code-planning

# Local development
clawdbot plugins install ./extensions/claude-code-planning -l
```

## Configuration

Add to your Clawdbot config:

```json5
{
  plugins: {
    entries: {
      "claude-code-planning": {
        enabled: true,
        config: {
          // Where to store cached project contexts
          projectsBase: "~/clawd/projects",

          // Directories to search for projects
          projectDirs: [
            "~/Documents/agent",
            "~/Projects",
            "~/code"
          ],

          // Days before context is considered stale
          stalenessDays: 7,

          // Default permission mode for sessions
          permissionMode: "default", // or "acceptEdits" or "bypassPermissions"

          // Default model (optional)
          model: "sonnet",

          // Explicit project aliases
          projects: {
            "myproject": "~/custom/path/myproject"
          }
        }
      }
    }
  }
}
```

## Tools

### project_context

Load, explore, or update project context.

**Actions:**
- `load` - Load cached context (explores if missing/stale)
- `explore` - Force re-exploration
- `update` - Add preferences or session summaries
- `list` - List all projects with cached context
- `format` - Format context as markdown

**Example:**
```typescript
{
  action: "load",
  project: "myproject"
}
```

### claude_code_start

Start a Claude Code session with enriched context.

**Parameters:**
- `project` - Project name or path (required)
- `prompt` - The enriched prompt for Claude Code (required)
- `originalTask` - Original user task before enrichment
- `worktree` - Git worktree name (e.g., "@experimental")
- `resumeToken` - Resume existing session
- `permissionMode` - Override default permission mode
- `model` - Override default model

**Example:**
```typescript
{
  project: "myproject",
  prompt: "Implement the user authentication feature using JWT tokens. Follow the existing patterns in src/auth/.",
  originalTask: "add auth",
  planningDecisions: ["Use JWT for tokens", "Store in httpOnly cookies"]
}
```

## Workflow

1. Agent receives user request
2. Agent uses `project_context` to load/explore project
3. Agent analyzes task and formulates enriched prompt
4. Agent uses `claude_code_start` to spawn session
5. Session runs in background

## Project Context

Context is stored in YAML format at:
```
~/clawd/projects/<project-name>/context.yaml
```

**Context Schema:**
```yaml
name: myproject
path: /path/to/project
lastExplored: 2026-01-24T04:30:00Z
type: React + TypeScript
packageManager: pnpm
testFramework: vitest
buildTool: vite
structure:
  src/: Source code
  src/components/: React components
conventions:
  - "Uses TypeScript strict mode"
  - "Uses Tailwind CSS"
claudeMd: |
  # Project Guidelines
  ...
preferences:
  - "Prefer pnpm over npm"
recentSessions:
  - date: 2026-01-23
    task: "Add dark mode"
    outcome: completed
```

## Future (Phase 2+)

- Telegram bubble integration
- Slack/Discord progress updates
- Advanced context (semantic search)
- Session analytics

## License

MIT
