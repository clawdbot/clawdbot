---
summary: "SkillKit: cross-agent skill management CLI for 17 AI coding agents"
read_when:
  - Porting skills from other AI coding agents to Moltbot
  - Managing skills across multiple AI agents
  - Looking for cross-agent skill portability
---

# SkillKit

SkillKit is a **universal CLI for managing AI agent skills** across 17 different coding agents. It provides cross-agent skill portability, team collaboration features, and smart project-aware recommendations. While ClawdHub is the Moltbot-specific skill registry, SkillKit enables you to translate and sync skills from other AI agents like Cursor, Claude Code, Codex, and more.

**Current version**: v1.7.2

Website: [agenstskills.com](https://agenstskills.com)

GitHub: [github.com/rohitg00/skillkit](https://github.com/rohitg00/skillkit)

npm: [npmjs.com/package/skillkit](https://www.npmjs.com/package/skillkit)

GitHub Packages: [github.com/rohitg00/skillkit/pkgs/npm/skillkit](https://github.com/rohitg00/skillkit/pkgs/npm/skillkit)

## Why use SkillKit with Moltbot

SkillKit complements Moltbot and ClawdHub by solving cross-agent workflows:

- **Skill portability**: Translate skills from Cursor, Claude Code, Codex, or other agents into Moltbot-compatible format.
- **Team collaboration**: Share skill configurations across your team with sync and import/export workflows.
- **Smart recommendations**: Get project-aware skill suggestions based on your codebase.
- **Multi-agent workflows**: Manage skills for multiple AI agents from a single CLI.
- **Marketplace access**: Browse 15,000+ skills from curated sources.

If you only use Moltbot, ClawdHub is the primary registry. If you work with multiple AI coding agents, SkillKit bridges the gap.

## Install the CLI

```bash
# npm (recommended)
npm install -g skillkit

# pnpm
pnpm add -g skillkit

# npx (no install)
npx skillkit --help

# GitHub Packages
npm install -g @rohitg00/skillkit --registry=https://npm.pkg.github.com
```

## Available Tools

The SkillKit extension provides 9 tools for Moltbot:

### skillkit_search

Search the SkillKit marketplace for AI agent skills.

```
skillkit_search(query: "react testing", agent: "cursor", limit: 10)
```

### skillkit_install

Install a skill from the marketplace.

```
skillkit_install(skill: "typescript-strict", agent: "clawdbot")
```

### skillkit_translate

Translate skills between different AI agent formats.

```
skillkit_translate(skill: "./cursor-rules", from: "cursor", to: "clawdbot", recursive: true)
```

### skillkit_recommend

Get smart skill recommendations based on your project.

```
skillkit_recommend(path: "./my-project", limit: 5)
```

### skillkit_sync

Sync skills between local and remote configurations.

```
skillkit_sync(direction: "push", agent: "clawdbot")
```

### skillkit_list

List available or installed skills.

```
skillkit_list(agent: "clawdbot", installed: true)
```

### skillkit_context

Analyze project context for intelligent recommendations.

```
skillkit_context(path: "./my-project", format: "json")
```

### skillkit_publish

Publish a skill to the SkillKit marketplace.

```
skillkit_publish(path: "./my-skill", name: "awesome-skill")
```

### skillkit_memory

Manage SkillKit memory for persisting preferences.

```
skillkit_memory(action: "save", key: "preferred_agent", value: "clawdbot")
```

## Supported Agents

SkillKit supports 17 AI coding agents:

| Agent | Format | Native Support |
|-------|--------|----------------|
| Claude Code | CLAUDE.md | ✅ |
| Cursor | .cursorrules | ✅ |
| Codex | AGENTS.md | ✅ |
| Gemini CLI | GEMINI.md | ✅ |
| OpenCode | OPENCODE.md | ✅ |
| Antigravity | .antigravity | ✅ |
| Amp | AMP.md | ✅ |
| Clawdbot/Moltbot | SKILL.md | ✅ |
| Droid | DROID.md | ✅ |
| GitHub Copilot | .github/copilot | ✅ |
| Goose | .goose | ✅ |
| Kilo | KILO.md | ✅ |
| Kiro CLI | .kiro | ✅ |
| Roo | .roo | ✅ |
| Trae | .trae | ✅ |
| Windsurf | .windsurfrules | ✅ |
| Universal | SKILL.md | ✅ |

## Skill Translation

SkillKit can translate skills between any supported agents. For example, to translate Cursor rules to Moltbot:

```bash
skillkit translate .cursorrules --from cursor --to clawdbot
```

Or use the `skillkit_translate` tool within Moltbot:

```
skillkit_translate(skill: ".cursorrules", from: "cursor", to: "clawdbot")
```

## Team Collaboration

SkillKit provides team collaboration features:

```bash
# Initialize team config
skillkit team init

# Share skills with team
skillkit team share

# Import team skills
skillkit team import

# Sync skills
skillkit team sync
```

## Project Context Analysis

SkillKit analyzes your project to provide intelligent recommendations:

```bash
skillkit context
```

This detects:
- Programming languages
- Frameworks (React, Next.js, Express, etc.)
- Build tools (Webpack, Vite, etc.)
- Testing frameworks
- Package managers
- Git configuration

## Related Resources

- [ClawdHub Skills](./clawdhub.md) - Moltbot-native skill registry
- [Creating Skills](./creating-skills.md) - How to create custom skills
- [SkillKit Website](https://agenstskills.com) - Browse the marketplace
