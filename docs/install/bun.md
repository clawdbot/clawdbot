---
summary: "Bun workflow (experimental): installs, patches, and gotchas vs pnpm"
read_when:
  - You want the fastest local dev loop (bun + watch)
  - You hit Bun install/patch/lifecycle script issues
---

# Bun (experimental)

Goal: run this repo with **Bun** (optional, not recommended for WhatsApp/Telegram)
without losing pnpm patch behavior.

⚠️ **Not recommended for Gateway runtime** (WhatsApp/Telegram bugs). Use Node for production.

## Status

- Bun is an optional local runtime for running TypeScript directly (`bun run …`, `bun --watch …`).
- `pnpm` is the default for builds and remains fully supported (and used by some docs tooling).
- Bun cannot use `pnpm-lock.yaml` and will ignore it.

## Install

Default:

```sh
bun install
```

Note: `bun.lock`/`bun.lockb` are gitignored, so there’s no repo churn either way. If you want *no lockfile writes*:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## pnpm patchedDependencies under Bun

pnpm supports `package.json#pnpm.patchedDependencies` and records it in `pnpm-lock.yaml`.
Bun (and npm/yarn) do not support pnpm patches, so we apply them in `postinstall` when pnpm is **not** the installer:

- [`scripts/postinstall.js`](https://github.com/clawdbot/clawdbot/blob/main/scripts/postinstall.js) detects the package manager via `npm_config_user_agent` and applies every entry from `package.json#pnpm.patchedDependencies` into `node_modules/...` using a built-in JS patcher (no `git`/system `patch` dependency).
- Under pnpm, this fallback is skipped because pnpm already applies `patchedDependencies` itself.

To add a new patch that works in both pnpm + Bun:

1. Add an entry to `package.json#pnpm.patchedDependencies`
2. Add the patch file under `patches/`
3. Run `pnpm install` (updates `pnpm-lock.yaml` patch hash)

## Bun lifecycle scripts (blocked by default)

Bun may block dependency lifecycle scripts unless explicitly trusted (`bun pm untrusted` / `bun pm trust`).
For this repo, the commonly blocked scripts are not required:

- `@whiskeysockets/baileys` `preinstall`: checks Node major >= 20 (we run Node 22+).
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes (no build artifacts).

If you hit a real runtime issue that requires these scripts, trust them explicitly:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Caveats

- Some scripts still hardcode pnpm (e.g. `docs:build`, `ui:*`, `protocol:check`). Run those via pnpm for now.
