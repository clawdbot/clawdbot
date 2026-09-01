# OpenClaw Documentation Overlay

Use this reference only for OpenClaw docs work. It layers OpenClaw-specific page
types, navigation, preservation, and validation rules on top of the general
technical-documentation skill.

## Reader Model

- Lead with the task the reader is trying to complete.
- Give one recommended path before alternatives.
- Keep main docs focused on the common path; move dense contracts and rare
  debugging detail to linked reference or troubleshooting pages.
- Explain production risks exactly where the reader can make the mistake.
- Link concepts, guides, references, CLI pages, SDK docs, testing, and
  troubleshooting so readers can continue without rereading.

## Page Types

Choose the page type before writing or reviewing:

- Overview: route readers to the right product area, integration path, or guide.
- Quickstart: get a new user to a working result with the fewest safe steps.
- Topic page: explain a major OpenClaw entity or surface end to end.
- Guide: walk through one workflow from prerequisites to production readiness.
- API/SDK/CLI reference: define every object, method, command, option, response,
  error, enum, default, and version rule in scope.
- Testing guide: show sandbox setup, fixtures, simulated failures, and live-mode
  differences.
- Troubleshooting guide: map observable symptoms to checks, causes, and fixes.
- Governance file: keep agent/contributor policy concrete, scoped, and aligned
  with current OpenClaw repo behavior.

## Topic Pages

Use this shape for major-entity pages:

1. Title naming the entity or surface.
2. Unheaded opening that says what it is, what it owns, and what it does not own.
3. Requirements, only when setup needs accounts, versions, permissions, plugins,
   operating systems, or credentials.
4. Quickstart with the recommended path and smallest reliable verification.
5. Configuration with task-critical options inline and exhaustive details linked
   to reference docs.
6. Major subtopics organized by reader intent, not under a generic "Subtopics"
   heading.
7. Troubleshooting with observable failures and concrete checks.
8. Related links to guides, references, commands, concepts, and adjacent topics.

## Guides

Use this shape for workflow pages:

1. Title naming the outcome, not the implementation detail.
2. Opening that states what the reader can accomplish.
3. Before you begin: accounts, keys, permissions, versions, tools, and
   assumptions.
4. Choose a path, only when the reader must decide.
5. Steps with verb-led headings, commands, expected output, and checks.
6. Test with the smallest reliable proof that the workflow works.
7. Production readiness: security, retries, limits, observability, migrations,
   and cleanup.
8. Troubleshooting near the workflow that causes the failures.
9. See also links to concepts, references, SDK docs, and adjacent guides.

## Docs IA And Navigation

- Read `docs/docs.json` before navigation changes.
- Keep topic pages and common workflows on the main reader path.
- Put exhaustive contracts, generated references, maintainer-only detail, and
  support material under `Reference` or another clearly scoped support page.
- Keep generated `plugins/reference/*` children and redirect-only pages out of
  visible navigation unless explicitly required.
- For moved pages, include a keep/drop/move/destination matrix in the handoff.
- Add "Read when" hints for docs-list routing when creating or changing pages
  that participate in the docs index.

## Source-Backed Content

- CLI docs must match current flags, output, errors, and examples.
- API/SDK docs must include fields, defaults, enum values, constraints, nullable
  behavior, lifecycle states, errors, and recovery guidance.
- Config docs must align exported types, schema/help output, metadata, baselines,
  and current docs.
- Dependency-backed behavior must be verified from upstream docs, source, or
  types before documenting defaults, timing, errors, or API behavior.
- Separate current behavior, shipped behavior, planned behavior, and maintainer
  intent.

## Examples

- Prefer complete copy-pasteable commands and snippets.
- Use realistic variable names and values.
- Mark placeholders with angle-bracket names such as `<API_KEY>`.
- Show expected success output when it helps verification.
- Keep one conceptual unit per code block and use language-specific fences.
- Avoid examples that hide setup, auth, error handling, or cleanup.
- Never expose real secrets, live config, phone numbers, private videos, or
  credentials.

## Preservation Reviews

For rewrites or splits:

- Identify source units before rewriting: headings, paragraphs, tables, examples,
  CLI/API contracts, warnings, and troubleshooting facts.
- Map each retained unit to a destination page or section.
- Do not treat a broad "covered" row as proof for dense source material; use
  line- or claim-level evidence when the source unit is dense.
- For dropped content, state whether it is obsolete, duplicated elsewhere,
  unsupported, or moved to a reference/support page.
- When a docs-audit artifact is used, verify it is mapped audit data with
  non-empty `mappings[]`, not only inventory or reindexed JSON.

## Validation

Choose the narrowest proof that covers the touched surface:

- `pnpm docs:list`
- `pnpm docs:check-mdx`
- `pnpm docs:check-links`
- `pnpm docs:check-i18n-glossary`
- `pnpm format:docs:check` or `pnpm lint:docs`
- `git diff --check`
- generated-doc or inventory checks when generated references, plugin catalogs,
  labeler, or docs scripts changed
- behavior tests or command probes when docs claim runtime behavior

If proof is blocked, say exactly which command was not run and why.
