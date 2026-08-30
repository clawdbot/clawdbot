---
summary: "How OpenClaw reviews dependency changes and packages plugin runtime dependencies"
read_when:
  - You are reviewing dependency changes or supply-chain risk
  - You are validating root or plugin npm packages before publishing
  - You want to understand bundled plugin dependencies
title: "Dependency locking"
---

OpenClaw uses `pnpm-lock.yaml` as its committed product dependency review boundary. It records the resolved dependency graph used by source checkouts and CI, so transitive changes remain visible in code review.

OpenClaw does not commit npm-format locks for product packages or publish them in package tarballs. [npm 12 removed shrinkwrap support](https://github.com/npm/cli/releases/tag/v12.0.0), including the `npm shrinkwrap` command and loading `npm-shrinkwrap.json` from package roots or dependency tarballs.

The trusted ClawHub and Vercel release toolchains are separate exceptions: `.github/release/clawhub-cli/package-lock.json` and `.github/release/vercel-cli/package-lock.json` are committed npm project locks used by release automation. Neither is shipped in an OpenClaw package.

These projects do not inherit root pnpm overrides. The Vercel project uses approved, version-scoped npm overrides for vulnerable upstream pins; remove each override when its owning dependency accepts a fixed version. Lock audits cover resolved package identities, not code already bundled into upstream CLI artifacts.

`pnpm deps:vuln:gate` audits the product pnpm lock and both release-tool locks independently against npm advisory data. Within each lockfile, known malware and critical advisories block anywhere, and high advisories block in the production/runtime graph. Dev-only high advisories and moderate or lower non-malware advisories are reported without blocking. Reports retain the source lockfile, so a release-tool finding does not imply product runtime exposure. Missing or invalid expected locks fail the gate.

Release dependency evidence runs this gate. Ordinary CI's `security-fast` job and the production audit pre-commit hook still audit only the product production graph.

## Published package behavior

Published OpenClaw plugin packages bundle their runtime dependency files in the tarball by default. Those bytes ship with the plugin and work the same way regardless of whether the operator uses npm, pnpm, or Bun.

Native-heavy plugins opt out of runtime dependency bundling because their dependency trees contain platform-specific or large native artifacts. Those plugins resolve dependencies at install time from exact-pinned direct dependencies. The root `openclaw` package also resolves dependencies at install time and does not bundle its full dependency tree.

Neither path publishes a lockfile:

- root and plugin tarballs contain neither `npm-shrinkwrap.json` nor `package-lock.json`;
- `pnpm-lock.yaml` remains the reviewed source dependency graph;
- npm package locks exist only transiently while OpenClaw validates package graphs or runs `npm ci` to assemble a bundled plugin.

## Validate npm dependency graphs

The npm-lock checker generates `package-lock.json` in a temporary directory, applies workspace overrides, and rejects any generated registry version absent from `pnpm-lock.yaml`. It does not write a lockfile into the checkout.

```bash
# Root and every publishable package
pnpm deps:npm-lock:check

# Only packages affected by the current changeset
pnpm deps:npm-lock:check:changed
```

## Inspect a plugin tarball

```bash
npm pack @openclaw/discord@<version> --json --pack-destination /tmp/openclaw-plugin-pack
tar -tf /tmp/openclaw-plugin-pack/openclaw-discord-<version>.tgz | grep '^package/node_modules/'
tar -tf /tmp/openclaw-plugin-pack/openclaw-discord-<version>.tgz | grep -E '^package/(npm-shrinkwrap|package-lock)\.json$' && exit 1 || true
```

The `node_modules` entries prove that the plugin carries its bundled runtime payload. The final check proves that neither npm lockfile format ships in the tarball.
