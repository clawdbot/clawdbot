---
summary: "Bun workflow for installs and package scripts; Node is required at runtime"
read_when:
  - You want to install dependencies or run package scripts with Bun
  - You hit Bun install/patch/lifecycle script issues
title: "Bun"
---

<Warning>
Bun releases up to 1.3.x cannot run the OpenClaw CLI or Gateway because they do not provide the required `node:sqlite` API. OpenClaw feature-probes the runtime: Bun builds that ship `node:sqlite` (1.4.0 canary and later) can run the CLI and Gateway experimentally, while older Bun versions are rejected at startup. Node remains the supported and recommended runtime for all OpenClaw runtime commands.
</Warning>

Bun remains usable as an optional package-script runner. The default package manager remains `pnpm`, which is fully supported and used by docs tooling. Bun cannot use `pnpm-lock.yaml` and ignores it, and current Bun versions fail to resolve this repo's `pnpm-workspace.yaml` layout during `bun install`, so dependency installs should use `pnpm install`.

## Install

<Steps>
  <Step title="Install dependencies">
    ```sh
    pnpm install
    ```

    Current Bun versions (including 1.4 canary) cannot resolve this repo's pnpm workspace layout, so `bun install` fails during workspace resolution. Use `pnpm install`.

  </Step>
  <Step title="Build and test">
    ```sh
    bun run build
    bun run vitest run
    ```

    Commands that launch OpenClaw itself should still run through Node; Bun runtimes that provide `node:sqlite` (1.4.0 canary and later) can run them experimentally.

  </Step>
</Steps>

## Lifecycle scripts

Bun blocks dependency lifecycle scripts unless explicitly trusted. For this repo, the commonly blocked scripts are not required:

- `baileys` `preinstall`: checks Node major >= 20 (OpenClaw requires Node 22.22.3+, 24.15+, or 25.9+, with Node 24 recommended)
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes (no build artifacts)

If you hit a runtime issue that needs these scripts, trust them explicitly:

```sh
bun pm trust baileys protobufjs
```

## Caveats

Some package scripts hardcode `pnpm` internally (for example `check:docs`, `ui:*`, `protocol:check`). Running them via `bun run` still shells out to `pnpm`, so just run those via `pnpm` directly.

## Related

- [Install overview](/install)
- [Node.js](/install/node)
- [Updating](/install/updating)
