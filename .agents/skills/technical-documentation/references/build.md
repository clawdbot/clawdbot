# Build Docs Playbook

Read `principles.md` first, then follow this execution flow.

## 1. Detect and align agent instruction and governance instructions

- Use `references/agent-and-contributing.md` as the source of truth for inventory, canonical/alias mapping, and precedence/conflict handling.
- Apply the symlink compatibility policy when in scope (`.agents` canonical directory with `.cursor` compatibility symlink when required by tooling).
- Long-running and extensive build investigations are acceptable when needed to resolve ambiguous or conflicting documentation sources.
- When available, use sub-agents for bounded parallel inventory/cross-check tasks and merge results into one canonical decision set.
- Capture required constraints before writing:
  - nested-agent rules, command/test requirements, PR workflow, and style checks.
- Use the same command and validation expectations in proposed snippets and examples.

## 2. Inventory product documentation surfaces (not governance only)

- For repo-wide builds, include docs content surfaces in addition to AGENTS/CONTRIBUTING.
- Inventory docs files and frameworks in scope (examples): `README*.md`, `docs/**`, `**/*.md`, `**/*.mdx`, `**/*.mdc`, `**/*.rst`, `**/*.rsc`, Fern/Mintlify config, Sphinx `conf.py`.
- Build a coverage map before drafting so governance and product docs are both represented.
- If scope is ambiguous, default to broader docs discovery first, then narrow intentionally.

## 3. Framework config and path mapping rules

- Detect framework/config first (for example Fern config, Sphinx `conf.py`, Mintlify config, or equivalent).
- Resolve every referenced path relative to the file/config that declares it, not assumed repo root.
- Treat filesystem paths and published URL routes as separate mappings; do not infer one from the other without config evidence.
- Validate both layers:
  - config -> file exists on disk
  - config/nav/routing -> URL path is consistent and reachable
- Record path-mapping assumptions and mismatches in handoff (`missing file`, `stale route`, `wrong base path`).

## 4. Define intent and success

- Audience, prerequisites, and job-to-be-done.
- Expected reader outcome immediately after completion.
- Doc type: tutorial, how-to, reference, explanation.
- Success criteria: what must be true after publish.

## 5. Build structure before prose

- Follow the funnel: what/why, quickstart, next steps.
- Keep headings informative and scannable.
- Open each section with the takeaway sentence.
- Add decision points with concrete branch guidance.
- For OpenClaw docs work, choose a page type from `references/openclaw.md` before drafting.
- Keep task-critical OpenClaw configuration inline; link exhaustive defaults, enums, schemas, generated references, and rare debugging workflows.

## 6. Build AGENTS.md and CONTRIBUTING.md intentionally

- Keep AGENTS.md structure consistent with `agents.md` ecosystem patterns:
  - include YAML frontmatter when present in repo style (`name`, `description`).
  - state persona scope and explicit instruction boundaries: `Always`, `Ask first`, `Never`.
  - include concrete commands and representative code examples.
- For CONTRIBUTING.md, prioritize issue triage flow, PR expectations, setup/test commands, and review gates.
- Add `Code of Conduct`, `Testing`, `Local checks`, and `PR expectations` sections when missing but required by the repo.
- If CONTRIBUTING.md is becoming too large, split by scope into linked docs (for example, framework/tool-specific setup and release workflows) and keep the root file as a concise entry point.
- Keep cross-file consistency: links from CONTRIBUTING.md to AGENTS.md (and vice versa) should be accurate and non-circular.
- If multiple AGENTS.md files exist, document the directory-level scope and avoid conflicting advice.
- If a required canonical entry file is missing (for example referenced `README.md` under a major directory), create the file in the same pass instead of adding a caveat-only note.
- For new entry files, keep them minimal and actionable: purpose, prerequisites, concrete run commands, and pointers to deeper docs.

## 7. Keep agent context tight

- Author once, expose twice:
  - keep one shared policy core and avoid duplicating guidance in separate agent-specific files.
  - publish that core through bounded glob-friendly files for Cursor/Claude plus explicit path references for Codex.
- For Cursor and Claude-style agents, avoid broad references. Use minimal globbing and narrow rule files that each serve one concern (for example, repo-wide setup, test rules, security checks).
- Keep AGENTS and alias files short-to-medium; move detailed runbooks to linked docs.
- For Codex, prefer explicit file references and concrete paths for exact reuse.
- Avoid adding unrelated historical or process details to avoid token/context drift during future tool reads.

## 8. Brownfield build mode

- Match existing terminology, navigation, and component patterns.
- Preserve existing IA unless there is a documented migration plan.
- For rewrites, include a migration note from old to new paths.
- Prefer smallest safe change set that improves utility.

## 9. Evergreen build mode

- Prefer stable concepts over release-tied narrative.
- Isolate volatile details under clearly marked version sections.
- Include maintenance signals: owners, refresh triggers, stale criteria.
- Include lifecycle notes: deprecation and replacement paths.

## 10. Writing constraints

- Use precise language and short, imperative instructions.
- Keep code examples copy-ready and self-contained.
- Include common failure modes and safe defaults.
- Avoid placeholder guidance that cannot be executed.

## 11. Agent and automation readiness

- Keep key facts in text (not image-only).
- Prefer structured lists/tables when choices matter.
- Add links and anchors that allow deterministic navigation.
- Document what can be checked automatically in CI.

## 12. Build validation

- Validate commands and snippets where possible.
- Verify links and references in changed sections.
- Run a reference existence sweep for every path/command you introduced.
- Verify docs-framework consistency when in scope (for example Sphinx/Fern config and referenced doc paths).
- For OpenClaw docs work, apply the validation checklist in `references/openclaw.md`.

## 13. Multilingual parity mode (when applicable)

- Pick one source-of-truth language for technical accuracy and release timing.
- Define parity target: full parity, staged parity, or intentional divergence per section.
- Keep structure aligned across locales (headings, anchors, section order) when possible.
- Preserve command/code correctness first; localize explanatory text second.
- If parity is not feasible, add a visible note with missing scope and expected sync window.
- Run a locale parity check for changed sections (added/removed steps, warnings, prerequisites).
- Record unresolved checks explicitly in handoff.
