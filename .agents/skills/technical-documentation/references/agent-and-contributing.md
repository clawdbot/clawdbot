# AGENT and CONTRIBUTING Principles

This reference consolidates the core rules for agent-policy and contributor-governance docs.

You must:

1. Discover repo-level and nested instruction files with:
   `rg --files -g 'AGENTS.md' -g 'CONTRIBUTING.md' -g 'CLAUDE.md' -g 'AGENT.md' -g '.cursor/rules/*' -g '.cursorrules' -g '.agent/**' -g '.agents/**' -g '.pi/**' -g 'AGENTS.*.md'`
2. Read the root and nearest-scope `AGENTS.md`/`CONTRIBUTING.md` pair before editing.
3. If alias files exist, normalize to one canonical source (`AGENTS.md` preferred when present; otherwise nearest alias), plus compatibility pointers or explicit symlink notes.
4. Document conflicting instructions and precedence decisions.

## GitHub + AGENTS baseline

Source: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors
Source: https://agents.md/
Source: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
Source: https://cobusgreyling.substack.com/p/what-is-agentsmd
Source: https://www.infoq.com/news/2025/08/agents-md/

Use these as default operating principles:

1. Keep `CONTRIBUTING.md` discoverable and actionable (`.github`, root, or `docs`).
2. Keep agent instructions concrete: real commands, real paths, clear boundaries.
3. Use explicit behavior boundaries for agents: `Always`, `Ask first`, `Never`.
4. Keep contributor and agent rules aligned with actual repository workflows.
5. Ensure clear guidance is provided to agents on if, when and how to raise issues and pull requests.

## Canonical and alias policy

Source: https://agents.md/
Source: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/

1. Treat `AGENTS.md` as canonical when present.
2. If `AGENTS.md` is absent, treat the nearest alias file as canonical.
3. Keep compatibility surfaces explicit: `AGENTS.md`, `AGENT.md`, `.cursorrules`, `.cursor/rules/*`, `.agent/`, `.agents/`, `.pi/`.
4. If aliases are used, document how they map back to canonical policy (or symlink when supported).
5. When repos use `.agents/` as canonical rule storage, keep `.cursor` as a compatibility symlink to `.agents` for Cursor rule auto-loading.
6. Keep policy DRY: store one shared policy core and expose it via aliases/symlinks instead of duplicating rule text.

## Context-awareness by agent platform

Source: https://github.com/vercel-labs/agent-skills/blob/main/AGENTS.md
Source: https://github.com/openai/codex/blob/main/AGENTS.md

1. For Cursor and Claude-style glob consumers, keep rule files narrow and bounded.
2. Avoid over-referencing large path sets that inflate context for glob-based agents.
3. For Codex-style workflows, prefer explicit file references and deterministic commands.
4. Keep long runbooks outside top-level policy files; link to scoped docs.
5. Ensure all agents have a happy path regardless so ensuring everything works across Codex, Claude and other coding agents.

## Symlink and compatibility operations

1. Preferred layout for multi-agent compatibility:
   - canonical rule directory: `.agents/`
   - Cursor compatibility path: `.cursor -> .agents` symlink
   - canonical policy doc: `AGENTS.md` pointing to `.agents` paths where relevant
2. Validate symlink state before finalizing changes:
   - if `.agents/` exists and `.cursor` is missing, create `.cursor` symlink to `.agents`
   - if `.cursor` is a symlink to another target, fix target or document why it must differ
   - if `.cursor` is a real directory/file, treat as migration conflict and ask before replacement
3. Validate rule payload through the canonical directory:
   - rules: `.agents/rules/*.mdc` with valid frontmatter (`description`, `globs`, `alwaysApply` as needed)
   - commands: `.agents/commands/*.md` when command routing is used
   - MCP config: `.agents/mcp.json` when MCP is in scope
4. Keep Codex behavior explicit:
   - `AGENTS.md` is primary for Codex repository instructions
   - `.cursor` compatibility is for Cursor auto-loading and does not replace canonical AGENTS policy
5. Record applied symlink fixes and unresolved compatibility gaps in validation notes.

## Dual-mode and deliverable standards

Source: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
Source: https://agents.md/
Source: https://github.com/openai/codex/blob/main/AGENTS.md
Source: https://github.com/vercel-labs/agent-skills/blob/main/AGENTS.md

1. Author one shared policy core (same commands, boundaries, and precedence) for all agents.
2. For Cursor/Claude-style agents, expose that core through glob-driven and bounded files (small `AGENTS.md`/rule surface).
3. For Codex, expose that same core through explicit file references with precise scope.
4. Where styles diverge, prefer the smallest common structure that satisfies both and avoid duplicating policy text.
5. Treat AGENTS/CONTRIBUTING as first-class deliverables when in scope.
6. Preserve required structure, constraints, and examples from existing files.
7. Align wording and commands with active repository instructions.

## Proactive issue discovery and remediation

Source: https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/
Source: https://github.com/openai/codex/blob/main/AGENTS.md
Source: https://github.com/vercel-labs/agent-skills/blob/main/AGENTS.md

1. Run a conflict matrix review across AGENTS/aliases/CONTRIBUTING and related command/rule docs before finalizing.
2. Treat the following as high-priority defects: missing referenced files, non-existent setup commands, command scope mismatches, and branch/commit policy conflicts.
3. Do not stop at caveat-only notes when a low-risk fix is clear; apply the fix in the same pass.
4. If a canonical entry file is missing (for example a directory `README.md` that docs depend on), create a minimal actionable file and update references.
5. Long-running investigations are acceptable when needed to uncover cross-file drift, especially in agent-instruction ecosystems.

## Discovery

1. Agents prefer simple terminal commands so having a well defined `make *` or `npm run *` is ideal
2. Agents can discover terminal commands through shell completion so providing shell completion helps

## CONTRIBUTING size and scope control

Source: https://contributing.md/how-to-build-contributing-md/
Source: https://blog.codacy.com/best-practices-to-manage-an-open-source-project
Source: https://mozillascience.github.io/working-open-workshop/contributing/
Source: https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md

1. Keep root `CONTRIBUTING.md` focused on setup, issue flow, PR flow, testing, and review gates.
2. Use issue/PR template links instead of embedding every process detail inline.
3. When the file grows too large, split by domain and link from root.
4. Move any large content into docs if avalible (for example Mintlify/Fern/Sphinx workflows) to avoid large contributor guide.
5. Optimize for agent/machine readability as well as humans.

## Example repos to emulate

Source: https://github.com/openclaw/openclaw/blob/main/AGENTS.md
Source: https://github.com/openclaw/openclaw/blob/main/CONTRIBUTING.md
Source: https://github.com/openclaw/openclaw/blob/main/VISION.md
Source: https://github.com/openai/codex/blob/main/AGENTS.md
Source: https://github.com/processing/p5.js/blob/main/AGENTS.md
Source: https://github.com/vercel-labs/agent-skills/blob/main/AGENTS.md
Source: https://github.com/agentsmd/agents.md/blob/main/AGENTS.md
Source: https://github.com/rails/rails/blob/main/CONTRIBUTING.md
Source: https://github.com/kubernetes/kubernetes/blob/master/CONTRIBUTING.md
Source: https://github.com/atom/atom/blob/master/CONTRIBUTING.md
Source: https://github.com/github/docs/blob/main/CONTRIBUTING.md
Source: https://github.com/facebook/react/blob/main/CONTRIBUTING.md

1. OpenClaw: strong real-world alias policy and AGENTS/CONTRIBUTING/VISION cohesion.
2. OpenAI Codex: strict command discipline and explicit scope control.
3. p5.js: explicit AI-policy guardrails in agent instructions.
4. Vercel + agentsmd spec: compact, context-efficient AGENTS patterns.
5. Rails/Kubernetes/Atom/GitHub Docs/React: contributor guidance patterns at different project scales.

## Practical merge policy

When these rules conflict:

1. Preserve contributor and reader task success first.
2. Preserve instruction clarity and unambiguous boundaries second.
3. Preserve long-term maintainability and context-efficiency third.
4. Add extra agent optimization only if it does not reduce human clarity or there is explict need.
5. Use your judgement as the expert.
