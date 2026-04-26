---
summary: "Comprehensive application modernization plan with frontend delivery skill updates"
title: "Application modernization plan"
read_when:
  - Planning a broad OpenClaw application modernization pass
  - Updating frontend implementation standards for app or Control UI work
  - Turning a broad product quality review into phased engineering work
---

# Application modernization plan

## Goal

Move the application toward a cleaner, faster, more maintainable product without
breaking current workflows or hiding risk in broad refactors. The work should
land as small, reviewable slices with proof for each touched surface.

## Principles

- Preserve current architecture unless a boundary is demonstrably causing churn,
  performance cost, or user-visible bugs.
- Prefer the smallest correct patch for each issue, then repeat.
- Separate required fixes from optional polish so maintainers can land high
  value work without waiting on subjective decisions.
- Keep plugin-facing behavior documented and backwards compatible.
- Verify shipped behavior, dependency contracts, and tests before claiming a
  regression is fixed.
- Make the main user path better first: onboarding, auth, chat, provider setup,
  plugin management, and diagnostics.

## Phase 1: Baseline audit

Inventory the current application before changing it.

- Identify the top user workflows and the code surfaces that own them.
- List dead affordances, duplicate settings, unclear error states, and expensive
  render paths.
- Capture current validation commands for each surface.
- Mark issues as required, recommended, or optional.
- Document known blockers that need owner review, especially API, security,
  release, and plugin contract changes.

Definition of done:

- One issue list with repo-root file references.
- Each issue has severity, owner surface, expected user impact, and a proposed
  validation path.
- No speculative cleanup items are mixed into required fixes.

## Phase 2: Product and UX cleanup

Prioritize visible workflows and remove confusion.

- Tighten onboarding copy and empty states around model auth, gateway status,
  and plugin setup.
- Remove or disable dead affordances where no action is possible.
- Keep important actions visible across responsive widths instead of hiding them
  behind fragile layout assumptions.
- Consolidate repeated status language so errors have one source of truth.
- Add progressive disclosure for advanced settings while keeping core setup fast.

Recommended validation:

- Manual happy path for first-run setup and existing user startup.
- Focused tests for any routing, config persistence, or status derivation logic.
- Browser screenshots for changed responsive surfaces.

## Phase 3: Frontend architecture tightening

Improve maintainability without a broad rewrite.

- Move repeated UI state transformations into narrow typed helpers.
- Keep data fetching, persistence, and presentation responsibilities separate.
- Prefer existing hooks, stores, and component patterns over new abstractions.
- Split oversized components only when it reduces coupling or clarifies tests.
- Avoid introducing broad global state for local panel interactions.

Required guardrails:

- Do not change public behavior as a side effect of file splitting.
- Keep accessibility behavior intact for menus, dialogs, tabs, and keyboard
  navigation.
- Verify that loading, empty, error, and optimistic states still render.

## Phase 4: Performance and reliability

Target measured pain rather than broad theoretical optimization.

- Measure startup, route transition, large list, and chat transcript costs.
- Replace repeated expensive derived data with memoized selectors or cached
  helpers where profiling proves value.
- Reduce avoidable network or filesystem scans on hot paths.
- Keep deterministic ordering for prompt, registry, file, plugin, and network
  inputs before model payload construction.
- Add lightweight regression tests for hot helpers and contract boundaries.

Definition of done:

- Each performance change records baseline, expected impact, actual impact, and
  remaining gap.
- No perf patch lands solely on intuition when cheap measurement is available.

## Phase 5: Type, contract, and test hardening

Raise correctness at the boundary points users and plugin authors depend on.

- Replace loose runtime strings with discriminated unions or closed code lists.
- Validate external inputs with existing schema helpers or zod.
- Add contract tests around plugin manifests, provider catalogs, gateway protocol
  messages, and config migration behavior.
- Keep compatibility paths in doctor or repair flows instead of startup-time
  hidden migrations.
- Avoid test-only coupling to plugin internals; use SDK facades and documented
  barrels.

Recommended validation:

- `pnpm check:changed`
- Targeted tests for every changed boundary.
- `pnpm build` when lazy boundaries, packaging, or published surfaces change.

## Phase 6: Documentation and release readiness

Keep user-facing docs aligned with behavior.

- Update docs with behavior, API, config, onboarding, or plugin changes.
- Add changelog entries only for user-visible changes.
- Keep plugin terminology user-facing; use internal package names only where
  needed for contributors.
- Confirm release and install instructions still match the current command
  surface.

Definition of done:

- Relevant docs are updated in the same branch as behavior changes.
- Generated docs or API drift checks pass when touched.
- The handoff names any skipped validation and why it was skipped.

## Recommended first slice

Start with a scoped Control UI and onboarding pass:

- Audit first-run setup, provider auth readiness, gateway status, and plugin
  setup surfaces.
- Remove dead actions and clarify failure states.
- Add or update focused tests for status derivation and config persistence.
- Run `pnpm check:changed`.

This gives high user value with limited architecture risk.

## Frontend skill update

Use this section to update the frontend-focused `SKILL.md` supplied with the
modernization task. If adopting this guidance as a repo-local OpenClaw skill,
create `.agents/skills/openclaw-frontend/SKILL.md` first, keep the frontmatter
that belongs in that target skill, then add or replace the body guidance with
the following content.

```markdown
# Frontend Delivery Standards

Use this skill when implementing or reviewing user-facing React, Next.js,
desktop webview, or app UI work.

## Operating rules

- Start from the existing product workflow and code conventions.
- Prefer the smallest correct patch that improves the current user path.
- Separate required fixes from optional polish in the handoff.
- Do not build marketing pages when the request is for an application surface.
- Keep actions visible and usable across supported viewport sizes.
- Remove dead affordances instead of leaving controls that cannot act.
- Preserve loading, empty, error, success, and permission states.
- Use existing design-system components, hooks, stores, and icons before adding
  new primitives.

## Implementation checklist

1. Identify the primary user task and the component or route that owns it.
2. Read the local component patterns before editing.
3. Patch the narrowest surface that solves the issue.
4. Add responsive constraints for fixed-format controls, toolbars, grids, and
   counters so text and hover states cannot resize the layout unexpectedly.
5. Keep data loading, state derivation, and rendering responsibilities clear.
6. Add tests when logic, persistence, routing, permissions, or shared helpers
   change.
7. Verify the main happy path and the most relevant edge case.

## Visual quality gates

- Text must fit inside its container on mobile and desktop.
- Toolbars may wrap, but controls must remain reachable.
- Buttons should use familiar icons when the icon is clearer than text.
- Cards should be used for repeated items, modals, and framed tools, not for
  every page section.
- Avoid one-note color palettes and decorative backgrounds that compete with
  operational content.
- Dense product surfaces should optimize for scanning, comparison, and repeated
  use.

## Handoff format

Report:

- What changed.
- What user behavior changed.
- Required validation that passed.
- Any validation skipped and the concrete reason.
- Optional follow-up work, clearly separated from required fixes.
```
