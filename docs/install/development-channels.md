---
summary: "Stable, extended-stable, beta, and dev channels: semantics, switching, pinning, and tagging"
read_when:
  - You want to switch between stable/extended-stable/beta/dev
  - You want to pin a specific version, tag, or SHA
  - You are tagging or publishing prereleases
title: "Release channels"
sidebarTitle: "Release Channels"
---

OpenClaw ships four update channels:

- **stable**: npm dist-tag `latest`. Recommended for most users.
- **extended-stable**: npm dist-tag `extended-stable`. A net-new, trailing
  supported-month package channel. It is package-only, and installation is
  foreground-only. A stored selection receives read-only update hints when
  `update.checkOnStart` is enabled, but never applies automatically.
- **beta**: npm dist-tag `beta`. Falls back to `latest` when `beta` is missing
  or older than the current stable release.
- **dev**: moving head of `main` (git). npm dist-tag `dev` when published. `main`
  is for experimentation and active development; it may contain incomplete
  features or breaking changes. Do not run it for production gateways.

Stable builds usually ship to **beta** first, get vetted there, then get
promoted to **latest** without a version bump. Maintainers can also publish
directly to `latest`. Dist-tags are the source of truth for npm installs.

## Switching channels

```bash
openclaw update --channel stable
openclaw update --channel extended-stable
openclaw update --channel beta
openclaw update --channel dev
```

`--channel` persists the choice to `update.channel` in config and drives both
install paths:

| Channel           | npm/package installs                                                                                                                                                                   | git installs                                                                                                                                                       |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stable`          | dist-tag `latest`                                                                                                                                                                      | latest stable git tag (excludes `-alpha.N`, `-beta.N`, `-rc.N`, `-dev.N`, `-next.N`, `-preview.N`, `-canary.N`, `-nightly.N`, and other named prerelease suffixes) |
| `extended-stable` | resolves the public npm `extended-stable` selector, verifies the exact selected package, and installs that exact version. Fails closed with no fallback to `latest`, `beta`, or `dev`. | unsupported: OpenClaw leaves the checkout unchanged and asks you to use a package installation                                                                     |
| `beta`            | dist-tag `beta`, falling back to `latest` when `beta` is missing or older                                                                                                              | latest beta git tag, falling back to the latest stable git tag when beta is missing or older                                                                       |
| `dev`             | dist-tag `dev` (rare; most dev users run git installs)                                                                                                                                 | fetches, rebases the checkout on the upstream `main` branch, builds, and reinstalls the global CLI                                                                 |

For `dev` git installs, the default checkout is `~/openclaw` (or
`$OPENCLAW_HOME/openclaw` when `OPENCLAW_HOME` is set); override with
`OPENCLAW_GIT_DIR`.

<Tip>
To keep stable and dev in parallel, use two separate checkouts and point each gateway at its own.
</Tip>

## One-off version or tag targeting

Use `--tag` to target a specific dist-tag, version, or package spec for a
single update **without** changing the persisted channel:

```bash
# Install a specific version
openclaw update --tag 2026.4.1-beta.1

# Install from the beta dist-tag (one-off, does not persist)
openclaw update --tag beta

# Switch to the moving GitHub main checkout (persistent)
openclaw update --channel dev

# Install a specific npm package spec
openclaw update --tag openclaw@2026.4.1-beta.1

# Install from GitHub main once without persisting the channel
openclaw update --tag main
```

Notes:

- `--tag` applies to **package (npm) installs only**; git installs ignore it.
- The tag is not persisted; the next `openclaw update` uses the configured
  channel.
- `--tag main` maps to the npm-compatible spec `github:openclaw/openclaw#main`
  for that one run. For a persistent moving `main` install, use
  `openclaw update --channel dev` (package installs switch to a git checkout)
  or reinstall with the installer's git method:
  `curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --version main`.
  The npm install path rejects GitHub/git source targets outright and points
  you at the git method instead.
- Downgrade protection: if the target version is older than the current
  version, OpenClaw prompts for confirmation (skip with `--yes`).
- Extended-stable always uses its verified exact package target. It is not a
  one-off alias for `--tag extended-stable`, and `--tag` cannot be combined
  with an effective extended-stable channel.
- `--channel beta` differs from `--tag beta`: the channel flow can fall back
  to stable/latest when beta is missing or older, while `--tag beta` always
  targets the raw `beta` dist-tag for that one run.

## Dry run

Preview what `openclaw update` would do without making changes:

```bash
openclaw update --dry-run
openclaw update --channel beta --dry-run
openclaw update --tag 2026.4.1-beta.1 --dry-run
openclaw update --dry-run --json
```

The dry run reports the effective channel, target version, planned actions,
and whether a downgrade confirmation would be required.

## Plugins and channels

Switching channels with `openclaw update` also syncs plugin sources:

- `dev` switches installed plugins that have a bundled counterpart back to
  their bundled (git checkout) source.
- `stable` and `beta` restore npm-installed or ClawHub-installed plugin
  packages.
- `extended-stable` resolves eligible official npm plugins with bare/default
  or `latest` intent to the exact installed core version. It does not query
  plugin `@extended-stable` tags at runtime.
- npm-installed plugins are updated after the core update completes.

## Checking current status

```bash
openclaw update status
```

Shows the active channel (with the source that decided it: config, git tag,
git branch, installed version, or default), install kind (git or package),
current version, and update availability.

## Tagging best practices

- Tag releases you want git checkouts to land on: `vYYYY.M.PATCH` for stable,
  `vYYYY.M.PATCH-beta.N` for beta. Named prerelease suffixes such as
  `-alpha.N`, `-rc.N`, and `-next.N` are not stable or beta targets.
- Legacy numeric stable tags such as `vYYYY.M.PATCH-1` and `v1.0.1-1` are still
  recognized as stable git tags for compatibility.
- `vYYYY.M.PATCH.beta.N` (dot-separated) is also recognized for compatibility;
  prefer `-beta.N`.
- Keep tags immutable: never move or reuse a tag.
- npm dist-tags remain the source of truth for npm installs:
  - `latest` -> stable
  - `extended-stable` -> trailing supported-month package release
  - `beta` -> candidate build or beta-first stable build
  - `dev` -> main snapshot (optional)

## macOS app availability

Beta and dev builds may **not** include a macOS app release. That is fine:

- The git tag and npm dist-tag can still publish on their own.
- Call out "no macOS build for this beta" in release notes or changelog.

## Related

- [Updating](/install/updating)
- [Installer internals](/install/installer)
