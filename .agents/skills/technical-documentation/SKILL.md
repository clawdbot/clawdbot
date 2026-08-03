---
name: technical-documentation
description: Build and review high-quality technical docs as well as agent instruction files in your repository.
license: MIT
metadata:
  source: "https://github.com/vincentkoc/dotskills"
---

# Technical Documentation

## Purpose

Produce and review technical documentation that is clear, actionable, and maintainable for both humans and agents, including contributor-governance files and agent instruction files.

## When to use

- Creating or overhauling docs in an existing product/codebase (brownfield).
- Building evergreen docs meant to stay accurate and reusable over time.
- Reviewing doc diffs for structure, clarity, and operational correctness.
- Running full-repo documentation audits that must include both governance files and product docs surfaces (`docs/`, `README*`, `.md/.mdx/.mdc`, Fern/Sphinx/Mintlify-style sources).
- Updating or reviewing AGENTS.md and/or CONTRIBUTING.md to keep agent and contributor workflows aligned with current repo practices.
- Improving repository onboarding/docs that include contribution instructions, issue templates, PR flow, and review gates.
- Designing governance documentation strategy for repos with alias instruction files (for example `CLAUDE.md`, `AGENT.md`, `.cursorrules`, `.cursor/rules/*`, `.agent/`, `.agents/`, `.pi/`) where `AGENTS.md` is treated as canonical when present and aliases should be kept as compatibility surfaces.
- Diagnosing agent-file drift where teams had to prompt iteratively to surface missing files, broken commands, or policy conflicts.
- Applying repository-specific documentation overlays, including OpenClaw page-type, docs IA, preservation, and validation rules when present.

## Workflow

1. Classify task: `build` or `review`; context: `brownfield` or `evergreen`.
2. Inventory full documentation scope early (governance + product docs): AGENTS/CONTRIBUTING/aliases plus docs directories, framework sources, and root/module READMEs.
3. Detect multilingual scope (README/docs in multiple languages) and define required parity level.
4. Read `references/agent-and-contributing.md` for agent instruction and `CONTRIBUTING.md` workflow rules (inventory, canonical/alias mapping, dual-mode balance, deliverable standards, and precedence/conflict handling).
5. Read `references/principles.md` for the governing ruleset (Matt Palmer & OpenAI).
6. For OpenClaw docs work, read `references/openclaw.md` before the build/review playbook.
7. For build tasks, follow `references/build.md`.
8. For review tasks, follow `references/review.md` and proactively detect issues without waiting for repeated prompts.
9. For complex or high-risk tasks (build or review), it is acceptable to run longer, deeper, and more exhaustive investigations when needed for confidence.
10. When available, use sub-agents for bounded parallel discovery/review work, then merge outputs into one coherent final deliverable.
11. Use `references/tooling.md` when platform/tooling choices affect recommendations.
12. Run a proactive issue sweep for both governance and docs-content surfaces, and fix high-confidence defects in the same pass unless explicitly asked for report-only mode.
13. In brownfield mode, prioritize compatibility with current docs IA, tooling, and release state.
14. In evergreen mode, prioritize timeless wording, update strategy, and durable structure.
15. Return deliverables plus validation notes, parity status, and remaining gaps.

## Sub-agent orchestration guidance

Prefer sub-agents when the repo is large or the requested change set is broad; use them by default for repo-wide, multi-framework, or high-conflict work.

- `inventory-agent` -> `agents/inventory-agent.md` (`fast` / Claude `haiku`): file/config discovery, coverage map, and missing-path checks.
- `governance-agent` -> `agents/governance-agent.md` (`thinking` / Claude `sonnet`): AGENTS/CONTRIBUTING/alias precedence, conflicts, and policy drift.
- `docs-framework-agent` -> `agents/docs-framework-agent.md` (`thinking` / Claude `sonnet`): framework config, relative path base, and file-path vs URL-path mapping checks.
- `synthesis-agent` -> `agents/synthesis-agent.md` (`long` / Claude `opus`): merge sub-agent outputs into one prioritized fix plan and unified precedence model.

## Inputs

- Doc type (tutorial, how-to, reference, explanation) and audience.
- File scope or diff scope.
- Docs framework/tooling constraints (Fern, Mintlify, Sphinx, etc.).
- Build/review mode and brownfield/evergreen intent.
- Target agent and human compatibility intent.
- Docs framework surfaces in scope (for example Fern, Sphinx, Mintlify, Markdown/MDX/MDC/RST/RSC files).
- Desired investigation depth/time budget (quick pass vs exhaustive review).
- Execution mode (`single-agent` or `sub-agent-assisted` when available).
- Remediation mode (`apply-fixes` by default, or `report-only` when requested).
- Multilingual scope: source-of-truth language, target locales, and parity expectations.
- Repository-specific overlay constraints, if any.

## Outputs

- Updated draft or review findings with clear next actions.
- Validation notes (what was checked, what remains).
- Navigation/maintenance recommendations for long-term quality.
- Governance-doc alignment summary when AGENTS/CONTRIBUTING were touched.
- Agent instruction-surface map (primary file, alias files, Codex/Claude/Cursor handling plan).
- Documentation-surface coverage map (what was reviewed under `/docs`, README hierarchy, and framework-specific source trees).
- Autodetected issue list with applied fixes (or explicit report-only findings).
- Delegation notes when sub-agents were used (scope delegated and how findings were merged).
- Multilingual parity note (in-sync, partial with rationale, or intentionally divergent).
- Repository-specific overlay notes when one was used.
