---
summary: "Bun workflow for installs, package scripts, and opt-in runtime use"
read_when:
  - You want to install dependencies or run package scripts with Bun
  - You want to run OpenClaw with Bun 1.4+
  - You hit Bun install/patch/lifecycle script issues
title: "Bun"
---

<Warning>
Node remains OpenClaw's primary, default, and recommended runtime. Bun 1.4+ builds that provide WAL-reset-safe `node:sqlite` can run the CLI, Gateway, and managed node host as an explicit opt-in. OpenClaw requires SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x; older Bun versions and builds with unsafe SQLite are rejected.
</Warning>

Bun remains usable as an optional package-script runner. The default package manager remains `pnpm`, which is fully supported and used by docs tooling. Bun cannot use `pnpm-lock.yaml` and ignores it, and current Bun versions fail to resolve this repo's `pnpm-workspace.yaml` layout during `bun install`, so dependency installs should use `pnpm install`.

## Install

<Steps>
  <Step title="Install dependencies">
    ```sh
    pnpm install
    ```

    Bun cannot resolve this repo's pnpm workspace layout, so `bun install` fails during workspace resolution. Use `pnpm install`.

  </Step>
  <Step title="Build and test">
    ```sh
    bun run build
    bun run vitest run
    ```

    Use Node by default for commands that launch OpenClaw.

  </Step>
  <Step title="Run OpenClaw with Bun">
    To run onboarding under Bun and install the managed Gateway under Bun:

    ```sh
    bun openclaw.mjs onboard --install-daemon --daemon-runtime bun
    ```

    For a managed node host, select Bun separately:

    ```sh
    bun openclaw.mjs node install --runtime bun
    ```

  </Step>
</Steps>

## Lifecycle scripts

Bun blocks dependency lifecycle scripts unless explicitly trusted. For this repo, the commonly blocked scripts are not required:

- `baileys` `preinstall`: checks Node major >= 20 (OpenClaw requires Node 22.22.3+, 24.15+, or 25.9+, with Node 26 recommended)
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
