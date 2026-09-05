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

## Check dependency advisories

The production audit pre-commit hook and ordinary CI's `security-fast` job remain zero-install, npm-only checks of the product production graph. They query npm bulk advisory data, not upstream repository advisories. A passing result is limited to that source and graph; it does not establish that dependencies are unaffected by all known vulnerabilities.

`pnpm deps:vuln:gate`, used by release dependency evidence, audits the product pnpm lock and both release-tool locks independently. It checks npm advisory data and adds published security advisories from verified public GitHub repositories. Repository mappings come from the manifests for exact locked npm package versions, not a package's latest manifest. The gate verifies that each repository is public before requesting advisories with the explicit `state=published` filter. It does not scan private repositories or unpublished advisories.

Within each lockfile, known malware and critical advisories block anywhere, and high advisories block in the production/runtime graph. Dev-only high advisories and moderate or lower non-malware advisories are reported without blocking. GitHub's `medium` severity maps to `moderate` in this policy. Upstream findings match the npm package identity and affected-version range against exact locked versions; only matches absent from the npm result for the corresponding lockfile and graph are added. Reports retain the source lockfile, so a release-tool finding does not imply product runtime exposure. Missing or invalid expected locks fail the gate.

Release automation reuses its existing standard `GH_TOKEN` only for GitHub API requests, never for npm registry requests. Local runs without that token use anonymous GitHub requests and their rate limits. No new OpenClaw configuration or operator credential setup is required.

### Interpret coverage

Release artifacts and the GitHub Actions step summary show npm coverage as `checked`, upstream coverage as `checked` or `partial`, mapped package-version counts, checked repository counts, coverage issues, and upstream-only findings. Findings identify their source as `npm-bulk` or `github-repository`; upstream findings also record matched locked versions. Even `checked` coverage is limited to these advisory sources, not comprehensive vulnerability clearance.

The upstream scan has fixed bounds: 2,500 exact package versions, 4,000 HTTP requests, and five minutes per run. It uses four concurrent requests, up to five pages of 100 advisories per repository, and at most 10,000 advisories per run. Each response is limited to 2 MiB and each request to 15 seconds. It does not retry or reuse stale cached results.

Missing or unsupported repository metadata, malformed affected-version ranges, exhausted request or pagination budgets, and request or rate-limit failures produce `partial` upstream coverage, not an unaffected result. Confirmed findings remain in the report and enter the same severity policy. Inspect the coverage issue subjects and reasons before interpreting a zero-finding result.

## Published package behavior

Published OpenClaw plugin packages bundle their runtime dependency files in the tarball by default. Those bytes ship with the plugin and work the same way regardless of whether the operator uses npm, pnpm, or Bun.

Native-heavy plugins opt out of runtime dependency bundling because their dependency trees contain platform-specific or large native artifacts. Those plugins resolve dependencies at install time from exact-pinned direct dependencies. The root `openclaw` package also resolves dependencies at install time and does not bundle its full dependency tree.

The bundled Anthropic plugin communicates directly with the separately installed `claude` executable. It does not depend on or copy the Claude Agent SDK into OpenClaw's package. The external ACPX plugin independently declares an ACP adapter that depends on the SDK; ACPX leaves those dependencies to installation from npm instead of bundling them into its published package.

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
