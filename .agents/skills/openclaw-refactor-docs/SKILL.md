---
name: openclaw-refactor-docs
description: Refactor an existing OpenClaw docs page with source-audited preservation, restructuring, and verification.
---

# OpenClaw Refactor Docs

## Overview

Use this skill when the user gives a target OpenClaw docs page and asks to
rewrite, refactor, reorganize, split, shorten, or improve it.

This skill builds on `openclaw-docs`: use that skill for style, page types,
structure, examples, discoverability, and verification. This skill adds the
rewrite workflow needed to avoid losing accurate behavior during a major docs
refactor.

## Inputs

Required:

- A target docs page path, such as `docs/plugins/codex-harness.md`.

Optional:

- Desired page type, such as topic page, guide, reference, or troubleshooting.
- Specific goals, such as shorter main page, move details to reference pages, or
  align with current CLI behavior.
- Related source files, schemas, commands, tests, specs, or PRs.

If the target page is missing or ambiguous, ask one concise question before
editing. Otherwise, proceed.

## Working Contract

Refactor the target page to be more useful, concise, and comprehensive within
its stated scope.

Do not treat a rewrite as permission to discard behavior facts. Preserve,
verify, move, or explicitly retire existing material. Incorrect docs are worse
than verbose docs.

Prefer this split:

- Topic or guide pages cover the 80/20 path, decisions readers must make, safe
  setup, smallest reliable verification, common failures, and links onward.
- Reference pages cover exhaustive fields, defaults, enums, limits, precedence
  rules, API contracts, narrow internals, and rare debugging details.
- Troubleshooting pages start from observable symptoms and map to checks,
  causes, and fixes.

## Workflow

### 1. Load the doc standard

Read `../openclaw-docs/SKILL.md` first. Apply its page-type, style,
examples, navigation, and verification guidance throughout the refactor.

Run `pnpm docs:list` when available, then read only the target page and the
likely entry points, references, or related pages needed for the refactor.

### 2. Classify the page

Before editing, decide the intended page type from `openclaw-docs`.

If the current page mixes page types, choose the main page type and plan where
the other material belongs:

- Move exhaustive contracts to an existing or new reference page.
- Move symptom-driven material to an existing or new troubleshooting page.
- Move narrow setup workflows to a guide when they interrupt the main path.
- Keep concise routing, decision, and safety details in the main page when
  readers need them to complete the workflow.

### 3. Preserve and audit existing facts

Create a working inventory from the old page before rewriting. Include:

- Config fields, flags, commands, slash commands, env vars, defaults, enums,
  nullable values, and constraints.
- Precedence rules, fallback behavior, caps, limits, rate limits, timeouts,
  lifecycle states, queueing behavior, and compatibility rules.
- Auth, permission, approval, sandbox, safety, privacy, and destructive-action
  behavior.
- Setup requirements, supported versions, dependencies, operating systems,
  credentials, and account requirements.
- Error messages, troubleshooting symptoms, diagnostics, and recovery steps.
- Examples, expected output, command routing tables, and cross-links.

For each fact, choose one outcome:

- Keep it in the refactored target page.
- Move it to a specific existing page.
- Move it to a specific new page.
- Delete it because current source proves it is obsolete or out of scope.

Do not infer defaults, permissions, policy, timeout behavior, or safety posture
from names or intent. Verify them.

### 4. Find source of truth

Use the nearest authoritative source for each behavior-sensitive claim:

- Public schema, plugin manifest, generated config docs, or exported types for
  config fields.
- CLI implementation, slash-command handlers, help text, and command tests for
  commands and flags.
- Runtime source and tests for lifecycle, queueing, permission, fallback,
  timeout, and provider behavior.
- Protocol docs, SDK facades, and contract tests for APIs and plugin surfaces.
- Existing docs only as secondary evidence unless the target is purely
  conceptual.

If a page promises a reference, compare its tables against the schema,
manifest, CLI help, generated docs, or exported types. Missing public fields,
defaults, precedence rules, caps, or side effects are correctness bugs.

### 5. Plan moved material

When moving detail out of the target page, record the destination before
editing:

- Existing page: name the page and section.
- New page: choose the page type, slug, title, frontmatter summary,
  `doc-schema-version: 1`, and `read_when` hints.
- Target page: keep a short summary and link from the point where readers need
  the deeper detail.

Avoid duplicate truth. If the same contract appears in multiple places, choose
one canonical page and link to it.

### 6. Rewrite

Rewrite in this order:

1. Make the first screen answer what the reader can do and why this page exists.
2. Put the recommended path before alternatives.
3. Keep only decision-making and common operational detail in the main flow.
4. Move exhaustive tables and rare details to the planned reference pages.
5. Preserve concise routing tables when they help readers choose commands,
   config paths, harnesses, plugins, providers, or references.
6. Add troubleshooting from observable symptoms, not internal guesses.
7. Link related concepts, guides, references, diagnostics, and adjacent tools.

Add `doc-schema-version: 1` to the YAML frontmatter of every docs page that the
refactor migrates, creates, or materially rewrites. Apply it only to docs page
files, not `docs.json`, glossary JSON, or other non-page metadata. If a
migrated page is generated, update the generator so regeneration preserves the
marker instead of hand-editing generated output.

Do not leave placeholders such as "TODO", "TBD", or "see docs" unless the user
explicitly asks for a draft.

### 7. Compare old and new

After editing, compare the old and new page:

- Confirm all behavior-sensitive facts were kept, moved, or intentionally
  deleted with source-backed reason.
- Check that the main page still covers the 80/20 scenario end to end.
- Check that reference pages remain exhaustive for the scope they claim.
- Check that links from the target page reach moved details.
- Check that headings are stable, searchable, and action-oriented.

If the refactor deliberately removes relevant material, say where it went or why
it was removed in the final report.

### 8. Verify

Run the smallest reliable docs checks for the touched surface:

- `pnpm docs:list`
- `git diff --check -- <touched-files>`
- Targeted `pnpm exec oxfmt --check --threads=1 <touched-files>`
- `pnpm docs:check-mdx`
- `pnpm docs:check-links`
- `pnpm docs:check-i18n-glossary` when link text, navigation, labels, or glossary
  surfaces changed
- Generated-doc checks when schemas, generated config docs, API docs, or
  generated baselines are touched

Run commands and examples from the page whenever feasible. If you cannot verify
a behavior-sensitive claim, either remove the claim, mark the uncertainty in the
work-in-progress report, or ask for the missing source.

## Final Report

Report:

- What changed in the target page.
- What details moved and their destination pages.
- What source-of-truth checks backed behavior-sensitive claims.
- What validation ran and what failed for unrelated reasons.

Do not include a long rewrite diary. Lead with remaining risks only if there are
any.
