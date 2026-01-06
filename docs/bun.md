# Bun (optional)

Goal: allow running this repo with Bun without maintaining a Bun lockfile or losing pnpm patch behavior.

## Status

- pnpm remains the primary package manager/runtime for this repo.
- Bun can be used for local installs/builds/tests, but Bun currently **cannot use** `pnpm-lock.yaml` and will ignore it.

## Install (no Bun lockfile)

Use Bun without writing `bun.lock`/`bun.lockb`:

```sh
bun install --no-save
```

This avoids maintaining two lockfiles. (`bun.lock`/`bun.lockb` are gitignored.)

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## pnpm patchedDependencies under Bun

pnpm supports `package.json#pnpm.patchedDependencies` and records it in `pnpm-lock.yaml`.
Bun does not support pnpm patches, so we apply them in `postinstall` when Bun is detected:

- `scripts/postinstall.js` runs only for Bun installs and applies every entry from `package.json#pnpm.patchedDependencies` into `node_modules/...` using `git apply` (idempotent).

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
