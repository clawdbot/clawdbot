---
name: openclaw-docs
description: Write or review high-quality OpenClaw developer documentation.
dependencies: []
---

# OpenClaw Docs

## Overview

Use this skill when writing, editing, or reviewing OpenClaw developer documentation for APIs, SDKs, CLI tools, integrations, quickstarts, platform guides, or technical product docs.

Write documentation that is concise, helpful, and comprehensive: fast for first success, precise for production, and easy to scan when debugging.

## Core Model

Use an OpenClaw documentation model, strengthened by Write the Docs principles:

- Lead with what the developer is trying to do.
- Give one recommended path before alternatives.
- Make examples runnable and realistic.
- Keep guides task-oriented and references exhaustive.
- Explain production risks exactly where developers can make mistakes.
- Link concepts, guides, API references, SDKs, testing, and troubleshooting so readers can move between them without rereading.
- Treat docs as part of the product lifecycle: draft them before or alongside implementation, review them with code, and keep them current.
- Make each page discoverable, addressable, cumulative, complete within its stated scope, and easy to skim.

## Structure

Choose the page type before writing:

- Overview: route readers to the right product, integration path, or guide.
- Quickstart: get a new user to a working result with the fewest safe steps.
- Topic page: give an end-to-end overview of a major domain entity, with setup,
  key subtopics, troubleshooting, and links to deeper references.
- Guide: explain one workflow from prerequisites to production readiness.
- API reference: define every object, endpoint, parameter, enum, response, error, and version rule.
- SDK or CLI reference: document install, auth, commands or methods, options, examples, and failure modes.
- Testing guide: show sandbox setup, fixtures, test data, simulated failures, and live-mode differences.
- Troubleshooting guide: map symptoms to checks, causes, and fixes.

Use this default topic page structure:

1. Title: name the major entity or surface.
2. Overview: explain what it is, what it owns, and what it does not own.
3. Requirements: include only when setup needs specific accounts, versions,
   permissions, plugins, operating systems, or credentials.
4. Quickstart: show the recommended setup path and smallest reliable verification.
5. Configuration: show the minimum configuration needed to use the surface,
   common variants users must choose between, and where each option is set:
   CLI, config file, environment variable, plugin manifest, dashboard, or API.
6. Subtopics: organize the entity's major concepts, workflows, and decisions by
   reader intent.
7. Troubleshooting: diagnose common observable failures.
8. Related: link to guides, references, commands, concepts, and adjacent topics.

Topic pages may be longer than quickstarts, but they should not become exhaustive
references. Move field tables, API contracts, narrow internals, legacy details,
and rare debugging workflows to linked reference or troubleshooting pages when
they interrupt the end-to-end overview.

For configuration, keep task-critical options inline. Link to reference docs for
full option lists, defaults, enums, generated schemas, and advanced settings. Do
not duplicate exhaustive config reference tables in topic pages unless the topic
page is itself the reference.

Use this default guide structure:

1. Title: name the outcome, not the implementation detail.
2. Opening: state what the reader can accomplish in one or two sentences.
3. Before you begin: list accounts, keys, permissions, versions, tools, and assumptions.
4. Choose a path: compare options only when the reader must decide.
5. Steps: use verb-led headings with code, expected output, and checks.
6. Test: show the smallest reliable proof that the integration works.
7. Production readiness: cover security, idempotency, retries, limits, observability, migrations, and cleanup.
8. Troubleshooting: include common errors near the workflow that causes them.
9. See also: link to concepts, API references, SDK docs, and adjacent guides.

Keep navigation user-intent based. Do not force readers to understand internal product taxonomy before they can pick a task.

## Documentation Lifecycle

Write and maintain docs with the same discipline as code:

- Draft docs early enough to expose unclear product, API, CLI, or config design.
- Keep docs source near the code, config, command, plugin, or protocol it describes when the repo layout allows it.
- Avoid duplicate truth. If the same contract appears in multiple places, pick the canonical page and link to it.
- Update docs in the same change as behavior, config, API, CLI, plugin, or troubleshooting changes.
- Remove, redirect, or clearly mark stale docs. Incorrect docs are worse than missing docs.
- Involve the right reviewers: code owners for behavior, support or QA for user failure modes, and docs maintainers for structure and style.
- Preserve older-version guidance only when users need it; otherwise document the current supported behavior.

Do not use FAQs as a dumping ground for unrelated material. Promote recurring questions into task, concept, troubleshooting, or reference pages.

## Writing Style

Write in a direct, practical voice:

- Use present tense and active voice.
- Address the reader as "you" when giving instructions.
- Prefer short paragraphs and scannable lists.
- Use concrete nouns: "agent profile", "Gateway webhook", "plugin manifest", "session state".
- Put caveats exactly where they affect the step.
- Avoid marketing language, hype, generic benefits, and vague claims.
- Avoid long conceptual lead-ins before the first actionable step.
- Do not over-explain common developer concepts unless the product has a nonstandard contract.
- Define OpenClaw-specific jargon and abbreviations before first use.
- Use sentence case for headings unless an OpenClaw product name, command, or identifier requires capitalization.
- Use descriptive link text that names the destination or action; avoid vague links such as "this page" or "click here".
- Avoid culturally specific idioms, violent idioms, and jokes that make docs harder to translate or scan.
- Write accessible prose: do not rely on color, screenshots, or visual position as the only way to understand an instruction.

Use headings that describe actions or reference surfaces:

- Good: "Create an agent", "Configure a Slack channel", "Repair plugin installation"
- Avoid: "How it works", "Under the hood", "Important notes" unless the section truly needs that shape

Use precise modal language:

- Use "must" for required behavior.
- Use "can" for optional capability.
- Use "recommended" for the default path.
- Use "avoid" for known footguns.
- Explain "why" only when it changes a developer decision.

## Detail Level

Vary detail by page type:

- Overview pages: be brief; help readers choose.
- Quickstarts: be procedural; include only what is needed for first success.
- Guides: be complete for one workflow; include decisions, side effects, and failure handling.
- References: be exhaustive; document every field, default, enum, nullable value, constraint, response, and error.
- Troubleshooting: be explicit; assume the reader is blocked and needs observable checks.

Go deep where mistakes are expensive:

- Authentication and secret handling
- Money movement, billing, permissions, and irreversible actions
- Webhooks, retries, duplicate events, and ordering
- Idempotency and concurrency
- Sandbox versus production differences
- Versioning, migrations, and backwards compatibility
- Limits, rate limits, quotas, and timeouts
- Error codes and recovery paths
- Data retention, privacy, and compliance-sensitive behavior

Do not bury this detail in a distant reference if developers need it to complete the task safely.

## Examples

Make examples production-shaped, even when using test data:

- Prefer complete copy-pasteable commands or snippets.
- Use realistic variable names and values.
- Mark placeholders clearly with angle-bracket names such as `<API_KEY>` or `<CUSTOMER_ID>`.
- Show expected success output after commands.
- Show full request and response examples for API references when response shape matters.
- Keep one conceptual unit per code block.
- Use language-specific code fences.
- Avoid toy examples that hide required setup, auth, error handling, or cleanup.

When multiple languages are useful, keep the same scenario across languages so readers can compare equivalents.

## Discoverability and Navigation

Design every page so readers can find it, link to it, and decide quickly whether it answers their question:

- Use goal-oriented titles and headings that match likely search terms.
- Start each page with a concise answer to "what can I do here?"
- Include metadata or frontmatter required by the OpenClaw docs index.
- Add "Read when" hints for docs-list routing when creating or changing OpenClaw docs pages that participate in the docs index.
- Link from likely entry points, not only from nearby internal taxonomy pages.
- Keep section headings stable enough for links from issues, PRs, support replies, and chat answers.
- Order tutorials and examples from prerequisites to advanced tasks; order reference pages alphabetically or topically when that helps lookup.
- State scope up front when a page is intentionally partial.

## API Reference Pattern

For endpoints, methods, objects, or commands, include:

1. Short purpose statement.
2. Auth or permission requirements.
3. Request shape, including path, query, headers, and body fields.
4. Parameter table with type, requiredness, default, constraints, enum values, and side effects.
5. Return shape with object lifecycle states.
6. Error cases with codes, causes, and recovery guidance.
7. Runnable example request.
8. Representative successful response.
9. Related guides and adjacent reference pages.

For nested objects, document child fields near their parent. Do not make readers jump across pages to understand the shape of a single request.

## Verification

Verify docs changes like product changes:

- Run the relevant docs build, docs index, formatter, link checker, or generated-doc check when available.
- Run commands, snippets, and examples that the page tells users to run whenever feasible.
- Confirm screenshots, UI labels, CLI output, config keys, flags, defaults, errors, and file paths match current behavior.
- Prefer executable checks over prose-only review for API, CLI, config, generated reference, and troubleshooting docs.
- If a verification step is not feasible, say what was not verified and why.

## Completeness Checks

Before finalizing a page, verify:

- The first screen tells readers what they can accomplish.
- The recommended path is obvious.
- Prerequisites are explicit and testable.
- Examples can run with documented inputs.
- The page has a clear audience: user, operator, plugin author, contributor, or maintainer.
- Test-mode and production-mode behavior are separated.
- Security-sensitive values are never exposed in examples.
- Every warning is attached to the step where it matters.
- Edge cases are documented where they affect implementation.
- API fields include types, defaults, constraints, and errors.
- Troubleshooting starts from observable symptoms.
- Related links help the reader continue without duplicating the page.
- The page says where to get support, file issues, or contribute when that is relevant to the reader's next step.
- The page is complete for the scope it claims, or the limitation is stated up front.

## Review Pass

Edit in this order:

1. Remove repetition and generic explanation.
2. Move conceptual background below the first useful action unless it is required to choose correctly.
3. Replace passive or abstract wording with concrete instructions.
4. Tighten headings until the outline reads like a task map.
5. Add missing operational details for production safety.
6. Check examples for copy-paste accuracy.
7. Add links between guide, reference, SDK, testing, and troubleshooting surfaces.
8. Check discoverability, addressability, accessibility, and docs-as-code verification.
