# Documentation Principles

This reference consolidates the core rules used by this skill.

## Matt Palmer: 8 rules for better docs

Source: https://mattpalmer.io/posts/2025/10/8-rules-for-better-docs/

Use these as default operating principles:

1. Write for humans, optimize for agents.
2. Start with a funnel: what/why, quickstart, next steps.
3. Use Diataxis to scaffold content.
4. Write with AI, but structure for agents.
5. Offload routine docs operations to background agents.
6. Automate quality with CI.
7. Automate scaffolding and repetitive workflow tasks.
8. Make contribution easy and visible.

## OpenAI cookbook: what makes documentation good

Source: https://cookbook.openai.com/articles/what_makes_documentation_good

Key quality constraints:

- Prefer specific and accurate terminology over niche jargon.
- Keep examples self-contained and minimize dependencies.
- Prioritize high-value topics over edge-case depth.
- Do not teach unsafe patterns (for example, exposed secrets).
- Open with context that helps readers orient quickly.
- Apply empathy and override rigid rules when it clearly improves outcomes.

## Practical merge policy

When these rules conflict:

1. Preserve reader task success first.
2. Preserve structural clarity second.
3. Preserve long-term maintainability third.
4. Add agent optimization only if it does not reduce human clarity.

For agent-instructions and contributor-governance specifics (AGENTS/aliases/CONTRIBUTING), use `references/agent-and-contributing.md` as the detailed additional source of truth.

When the target repo or request is OpenClaw-specific, layer `references/openclaw.md` on top of these general rules. Otherwise ignore that repo-specific overlay.

## Execution policy for this skill

- Long-running and extensive investigations are allowed for both build and review work when needed to resolve ambiguity or cross-file drift.
- Use sub-agents when available for bounded parallel discovery, verification, or cross-source comparison.
- Keep one merged outcome: sub-agent outputs must be normalized into a single consistent recommendation/fix set.

## Multilingual parity rule

When docs exist in multiple languages, target cross-locale parity for task-critical content (steps, warnings, prerequisites, and limits). If full parity is not possible, publish explicit parity status and sync intent.
