---
summary: "How the installer scripts work (install.sh + install-cli.sh), flags, and automation"
read_when:
  - You want to understand `clawd.bot/install.sh`
  - You want to automate installs (CI / headless)
  - You want to install from a GitHub checkout
---

# Installer internals

Clawdbot ships two installer scripts (served from `clawd.bot`):

- `https://clawd.bot/install.sh` — “recommended” installer (global npm install by default; can also install from a GitHub checkout)
- `https://clawd.bot/install-cli.sh` — non-root-friendly CLI installer (installs into a prefix with its own Node)

To see the current flags/behavior, run:

```bash
curl -fsSL https://clawd.bot/install.sh | bash -s -- --help
```

## install.sh (recommended)

What it does (high level):

- Detect OS (macOS / Linux / WSL).
- Ensure Node.js **22+** (macOS via Homebrew; Linux via NodeSource).
- Choose install method:
  - `npm` (default): `npm install -g clawdbot@latest`
  - `git`: clone/build a source checkout and install a wrapper script
- On Linux: avoid global npm permission errors by switching npm’s prefix to `~/.npm-global` when needed.
- If upgrading an existing install: runs `clawdbot doctor --non-interactive` (best effort).
- For git installs: runs `clawdbot doctor --non-interactive` after install/update (best effort).
- Mitigates `sharp` native install gotchas by defaulting `SHARP_IGNORE_GLOBAL_LIBVIPS=1` (avoids building against system libvips).

If you *want* `sharp` to link against a globally-installed libvips (or you’re debugging), set:

```bash
SHARP_IGNORE_GLOBAL_LIBVIPS=0 curl -fsSL https://clawd.bot/install.sh | bash
```

### Discoverability / “git install” prompt

If you run the installer while **already inside a Clawdbot source checkout** (detected via `package.json` + `pnpm-workspace.yaml`), it prompts:

- update and use this checkout (`git`)
- or migrate to the global npm install (`npm`)

In non-interactive contexts (no TTY / `--no-prompt`), you must pass `--install-method git|npm` (or set `CLAWDBOT_INSTALL_METHOD`), otherwise the script exits with code `2`.

### Why Git is needed

Git is required for the `--install-method git` path (clone / pull).

For `npm` installs, Git is *usually* not required, but some environments still end up needing it (e.g. when a package or dependency is fetched via a git URL). The installer currently ensures Git is present to avoid `spawn git ENOENT` surprises on fresh distros.

### Why npm hits `EACCES` on fresh Linux

On some Linux setups (especially after installing Node via the system package manager or NodeSource), npm’s global prefix points at a root-owned location. Then `npm install -g ...` fails with `EACCES` / `mkdir` permission errors.

`install.sh` mitigates this by switching the prefix to:

- `~/.npm-global` (and adding it to `PATH` in `~/.bashrc` / `~/.zshrc` when present)

## install-cli.sh (non-root CLI installer)

This script installs `clawdbot` into a prefix (default: `~/.clawdbot`) and also installs a dedicated Node runtime under that prefix, so it can work on machines where you don’t want to touch the system Node/npm.

Help:

```bash
curl -fsSL https://clawd.bot/install-cli.sh | bash -s -- --help
```

## Patches (npm / pnpm / bun)

Clawdbot’s `postinstall` script includes a builtin JS patcher that can apply `pnpm.patchedDependencies` patches even when the package manager doesn’t support them (notably Bun). pnpm itself already applies `pnpm.patchedDependencies`, so the fallback skips pnpm installs to avoid double-applying.

See: [Bun notes](/install/bun).
