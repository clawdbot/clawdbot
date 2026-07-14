---
summary: "Bun workflow for installs and package scripts; Node is required at runtime"
read_when:
  - You want to install dependencies or run package scripts with Bun
  - You hit Bun install/patch/lifecycle script issues
title: "Bun"
---

<Warning>
Bun cannot run the OpenClaw CLI or Gateway because it does not provide the required `node:sqlite` API. Install a supported Node version for all OpenClaw runtime commands.
</Warning>

Bun remains usable as an optional dependency installer and package-script runner. The default package manager remains `pnpm`, which is fully supported and used by docs tooling. Bun cannot use `pnpm-lock.yaml` and ignores it.

## Install

<Steps>
  <Step title="Install dependencies">
    ```sh
    bun install
    ```

    `bun.lock` / `bun.lockb` are gitignored, so there is no repo churn. To skip lockfile writes entirely:

    ```sh
    bun install --no-save
    ```

  </Step>
  <Step title="Build and test">
    ```sh
    bun run build
    bun run vitest run
    ```

    Commands that launch OpenClaw itself must still run through Node.

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
