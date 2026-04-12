# Scripts Guide

This directory owns local tooling, script wrappers, and generated-artifact helper rules.

## Wrapper Rules

- Prefer existing wrappers over raw tool entrypoints when the repo already has a curated seam.
- For tests, prefer `scripts/run-vitest.mjs` or the root `pnpm test ...` entrypoints over raw `vitest run` calls.
- For lint/typecheck flows, prefer `scripts/run-oxlint.mjs` and `scripts/run-tsgo.mjs` when adding or editing package scripts or CI steps that should honor repo-local runtime behavior.

## Local Heavy-Check Lock

- Respect the local heavy-check lock behavior in `scripts/lib/local-heavy-check-runtime.mjs`.
- Do not bypass that lock for real heavy commands just to make a local loop look faster.
- Metadata-only or explicitly narrow commands may skip the lock when the existing helper logic says that is safe.
- If you change the lock heuristics, add or update the narrow tests under `test/scripts/`.

## Generated Outputs

- If a script writes generated artifacts, keep the source-of-truth generator, the package script, and the matching verification/check command aligned.
- Prefer additive generator/check pairs like `*:gen` and `*:check` over one-off undocumented scripts.

## Scope

- Keep script-runner behavior, wrapper expectations, and generated-artifact guidance here.
- Leave repo-global verification policy in the root `AGENTS.md`.
