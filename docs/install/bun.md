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

- `baileys` `preinstall`: checks Node major >= 20 (OpenClaw requires Node 24.16+ or 26.1+, with Node 26 recommended)
- `protobufjs` `postinstall`: emits warnings about incompatible version schemes (no build artifacts)

If you hit a runtime issue that needs these scripts, trust them explicitly:

```sh
bun pm trust baileys protobufjs
```

## Caveats

Bun 1.4.2 can retain SQLite statement handles and WAL/shared-memory files after
`DatabaseSync.close()` or `Symbol.dispose()`. Use Node when database files must
be released promptly after closing. This is a temporary runtime workaround while
the [upstream close fix](https://github.com/oven-sh/bun/pull/40005) is pending;
OpenClaw cannot finalize these handles through Bun's public `node:sqlite` API.

On macOS, install Homebrew SQLite to enable native `sqlite-vec` KNN memory queries:

```sh
brew install sqlite
```

OpenClaw automatically selects a WAL-reset-safe, extension-capable SQLite library
from Homebrew or MacPorts before opening a database, and uses the same library in
the memory KNN child process. Discovery checks `$HOMEBREW_PREFIX/opt/sqlite/lib/libsqlite3.dylib`
first, then the standard Homebrew paths under `/opt/homebrew` and `/usr/local`,
then `/opt/local/lib/libsqlite3.dylib` for MacPorts. Linux and Windows Bun already
support extension loading and need no additional SQLite installation.

To override discovery, set `OPENCLAW_SQLITE_LIBRARY` in the process environment
before starting OpenClaw:

```sh
OPENCLAW_SQLITE_LIBRARY=/path/to/libsqlite3.dylib bun openclaw.mjs gateway
```

The override must point to a loadable SQLite library that meets the WAL safety
floor and supports extension loading. An invalid override fails with an error
explaining how to fix or unset it. Node and Bun on platforms other than macOS
ignore this override; Gateway startup logs a warning when it is ignored.

If you previously used a Bun preload script that calls `Database.setCustomSQLite()`,
remove that preload and set `OPENCLAW_SQLITE_LIBRARY` to the same library path
instead. Bun permits that hook only once per process; keeping the preload causes
startup to fail with `SQLite already loaded`, even when both selections name the
same library. The environment override lets OpenClaw select the library before
opening databases and forward the path to the memory KNN child.

Without a suitable library on macOS, Bun keeps Apple's system SQLite, which omits
native extension loading. OpenClaw can open ordinary agent databases when that
library meets the WAL safety floor. Memory search falls back to a batched
embedding scan with the same provider and source filters and cancellation checks
between batches. This can be slower on large indexes.

Some package scripts hardcode `pnpm` internally (for example `check:docs`, `ui:*`, `protocol:check`). Running them via `bun run` still shells out to `pnpm`, so just run those via `pnpm` directly.

## Related

- [Install overview](/install)
- [Node.js](/install/node)
- [Updating](/install/updating)
