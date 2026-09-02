# ACPX Extension Notes

This file applies to work under `extensions/acpx/`.

## Purpose

The ACPX extension is a thin OpenClaw wrapper around the published `acpx` package. Keep reusable ACP runtime logic in `openclaw/acpx`, not in this extension.

## Default Version Policy

- `extensions/acpx/package.json` should point at a published npm release by default.
- Do not leave the extension pinned to a temporary GitHub commit or local checkout once the ACPX release exists.
- Do not leave temporary pnpm build-script allowlist exceptions behind after switching back to a published ACPX package.

## Unreleased ACPX Development Flow

Use this flow when OpenClaw needs unreleased ACPX changes before the ACPX version is published.

1. Make the ACPX code change in the `openclaw/acpx` repo first.
2. In OpenClaw, temporarily point `extensions/acpx/package.json` at the ACPX GitHub commit you need.
3. If pnpm blocks ACPX lifecycle/build scripts for that temporary GitHub-sourced package, temporarily add `acpx: true` to `allowBuilds` in `pnpm-workspace.yaml`.
4. Refresh the root workspace lock:
   - `pnpm install --lockfile-only --filter ./extensions/acpx`
5. Refresh the extension-local npm lock for install metadata:
   - `cd extensions/acpx && npm install --package-lock-only --ignore-scripts`
6. Rebuild OpenClaw and restart the gateway before doing live ACP validation.
7. Once ACPX is released, switch `extensions/acpx/package.json` back to the published npm version and refresh the same lockfiles again.
8. Remove any temporary `acpx` build-script allowlist entry that was only needed for the GitHub-sourced development pin.

## Lockfile Notes

- `pnpm-lock.yaml` is the tracked workspace lockfile and must match the ACPX version referenced by `extensions/acpx/package.json`.
- `extensions/acpx/package-lock.json` is useful local install metadata for the plugin package.
- If `extensions/acpx/package-lock.json` is gitignored in this repo state, regenerating it is still useful for local verification, but it will not appear in `git status`.

## Local Runtime Validation

When ACPX integration changes here, prefer this sequence:

1. `pnpm install --filter ./extensions/acpx`
2. `pnpm test:extension acpx`
3. `pnpm build`
4. Restart the local gateway if ACP runtime behavior or bundled plugin wiring changed.
5. If the change affects direct ACP behavior in chat, run a real ACP smoke after restart.

## Direct ACPX Binary Policy

- Prefer the plugin-local ACPX binary under `extensions/acpx/node_modules/.bin/acpx`.
- Do not rely on a globally installed `acpx` binary for OpenClaw ACP validation.
- If the plugin-local ACPX binary is missing or on the wrong version, reinstall it from the version pinned in `extensions/acpx/package.json`.

## Boundary Rule

If a change feels like shared ACP runtime behavior instead of OpenClaw-specific glue, move it to `openclaw/acpx` and consume it from here instead of re-implementing it inside `extensions/acpx`.
