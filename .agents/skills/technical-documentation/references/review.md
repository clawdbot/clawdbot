# Review Docs Playbook

Read `principles.md` first, then apply this checklist.

## 1. Scope and classification

- Identify doc type and target audience.
- Confirm brownfield vs evergreen intent.
- Confirm expected outcome for the reader.
- For full-repo reviews, explicitly include both governance surfaces and product-doc surfaces (`docs/`, README trees, `.md/.mdx/.mdc`, `.rst/.rsc`, framework docs configs).
- For OpenClaw docs reviews, apply `references/openclaw.md` for page type, docs IA, preservation, examples, and validation checks.

## 2. Investigation behavior

- Proactively find issues and risks without waiting for repeated prompts.
- If there are signals of deeper problems, continue investigation beyond the first pass.
- Long-running and extensive investigations are acceptable when needed for confidence and correctness.
- When available, use sub-agents for bounded parallel discovery (for example file-inventory, command validation, or cross-doc consistency checks), then merge to one final issue set.
- When no issues are found, state that explicitly and call out residual risks or validation gaps.
- Default to `apply-fixes` for high-confidence documentation defects unless the user explicitly requests `report-only`.
- Do not stop at AGENTS/CONTRIBUTING checks when the task is documentation-wide; continue into docs-content and docs-framework surfaces.

## 3. Governance surface review

- Use `references/agent-and-contributing.md` as the source of truth for inventory, canonical/alias mapping, and precedence/conflict handling.
  For AGENTS.md:

- confirm persona intent, scope, and command/tool boundaries are explicit.
- check frontmatter style matches repo conventions when present.
- ensure `Always`, `Ask first`, and `Never` boundaries are present when expected.
- require concrete command examples and repo-specific paths to avoid ambiguity.

For CONTRIBUTING.md:

- verify issue/PR workflow is complete and actionable.
- ensure local setup, lint/test commands, and review criteria are accurate.
- ensure governance does not conflict with nested AGENTS instructions.
- flag oversized files that should be split into linked section docs (for example tool-specific setup and release docs).

For agent-platform awareness:

- confirm references are minimal and scoped for Cursor/Claude glob behavior.
- confirm Codex-facing guidance uses explicit file references.
- confirm both surfaces represent the same shared policy core (commands, boundaries, and precedence), not divergent guidance.
- audit `.agents`/`.cursor` compatibility behavior:
  - verify canonical rule directory and symlink state match repo policy
  - verify symlink target integrity and platform/tooling expectations
  - verify AGENTS policy references remain canonical for Codex even when `.cursor` compatibility exists
- check for context bloat from duplicated policy statements across agent and contributor files.
- check for conflicting rules, skills and agent instructions
- check for conflicting information in agent instructions vs codebase
- check for broken or missing referenced files (for example README/index files named as canonical entry points).
- check for setup/command drift (for example non-existent install commands, root-level commands that should be module-scoped).

## 4. Product documentation surface review

- Verify docs IA coverage across root/module `README*` files and `docs/**` trees.
- Review framework-native docs sources in scope (for example Fern, Mintlify, Sphinx, MkDocs) and ensure guidance matches actual source-of-truth files.
- Check `.md/.mdx/.mdc/.rst/.rsc` for stale commands, missing prerequisites, and broken cross-links.
- Confirm referenced doc paths and anchors exist.
- Flag docs that should be split/merged to improve discoverability and maintenance.
- For OpenClaw docs, check `docs/docs.json`, docs-list routing hints, main path versus `Reference` placement, and generated-reference visibility.
- For OpenClaw rewrites or page splits, require source-backed keep/drop/move/destination coverage for important claims, warnings, examples, commands, fields, and troubleshooting facts.

## 5. Framework config and path mapping checks

- Detect and read framework config first (for example Fern config, Sphinx `conf.py`, Mintlify config, or equivalent).
- Resolve path references relative to the declaring file/config.
- Treat filesystem paths and published URL routes as separate maps; verify both.
- Flag path-map drift explicitly (`missing file`, `stale route`, `wrong base path`).

## 6. Structural review

- Funnel check: what/why, quickstart, next steps.
- Validate heading flow and navigation discoverability.
- Flag critical content trapped in images or buried sections.
- Check Diataxis alignment and split mixed-purpose sections.
- For OpenClaw docs, confirm the content matches an explicit page type from `references/openclaw.md`.

## 7. Writing quality review

- Check for concise, scannable paragraphs.
- Remove ambiguous pronouns and undefined terms.
- Verify examples are executable and scoped correctly.
- Verify tone is directive, technical, and non-hand-wavy.

## 8. Brownfield review mode

- Verify compatibility with existing docs IA and conventions.
- Verify anchors, redirects, and cross-doc links remain valid.
- Flag regressions in onboarding and task completion paths.
- Ensure changed terminology is intentionally propagated.

## 9. Evergreen review mode

- Flag date-stamped or brittle wording without version scope.
- Check ownership and refresh signals are present.
- Ensure recommendations remain valid after routine product evolution.
- Flag missing deprecation/migration guidance.

## 10. Tooling and platform review

Read `tooling.md` if platform fit is uncertain.

- Check whether content uses platform primitives effectively.
- Flag structure that fights the chosen docs platform.
- Recommend targeted platform-aware improvements.

## 11. Multilingual parity review (when applicable)

- Confirm declared source-of-truth language and expected parity policy.
- Compare changed sections across locales for step/order/warning drift.
- Flag missing updates to prerequisites, version notes, limits, and safety guidance.
- Allow intentional divergence only when rationale is explicit and user-impact is low.
- Require a reader-visible status note when locale parity is partial.

## 12. Output format

1. Blocking issues (file + required fix)
2. Non-blocking improvements
3. Validation notes (done vs pending)
