---
doc-schema-version: 1
summary: "Release lanes, operator checklist, validation boxes, version naming, and cadence"
title: "Release policy"
read_when:
  - Looking for public release channel definitions
  - Running release validation or package acceptance
  - Looking for version naming and cadence
---

This page is an index. The release runbook is documented on nine pages, one
per reader job. Open the page that matches your task and complete it there;
no procedure is split across pages.

OpenClaw exposes four user-facing update channels:

- stable: the promoted regular release on npm `latest`
- extended-stable: the trailing completed month's `.33+` maintenance line on
  npm `extended-stable`
- beta: prerelease tags on npm `beta`
- dev: the moving head of `main`

Extended-stable ships the trailing month's Gateway, official npm plugins, and
Docker images without moving regular `latest` or `main` selectors.

Tideclaw alpha builds are a separate internal prerelease track (npm dist-tag `alpha`), covered under [NPM workflow inputs](/reference/releasing/npm-workflow-inputs) and [Release test boxes](/reference/releasing/test-boxes).

## What each page covers

- [Version naming and cadence](/reference/releasing/versioning) — release version formats, git tags, npm dist-tags, and the beta-first cadence.
- [Release preflight](/reference/releasing/preflight) — checks, generators, and manual workflows to run before a release is tagged.
- [Regular release checklist](/reference/releasing/regular-release) — the twelve-step operator checklist for cutting a regular beta or stable release.
- [Release test boxes](/reference/releasing/test-boxes) — Full Release Validation and the Vitest, Docker, QA Lab, and Package boxes.
- [Release publish automation](/reference/releasing/publish-automation) — OpenClaw Release Publish order, tooling tags, and Windows, Android, and ClawHub recovery.
- [Beta and latest release sequence](/reference/releasing/beta-latest-sequence) — the orchestrated eight-step regular stable release sequence and dist-tag promotion.
- [Stable main closeout](/reference/releasing/main-closeout) — bringing main to the shipped release state and recovering a failed closeout.
- [Extended-stable monthly release](/reference/releasing/extended-stable) — the monthly Gateway extended-stable lane: prepare, publish, verify, and recover.
- [NPM workflow inputs](/reference/releasing/npm-workflow-inputs) — operator-controlled inputs for the npm release, publish, and release-check workflows.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/reference/RELEASING#release-preflight` still resolves. Each entry points at the page that now holds the content.

- <a id="version-naming" />[Version naming](/reference/releasing/versioning#version-naming)
- <a id="release-cadence" />[Release cadence](/reference/releasing/versioning#release-cadence)
- <a id="monthly-gateway-extended-stable-publication" />[Monthly Gateway extended-stable publication](/reference/releasing/extended-stable#monthly-gateway-extended-stable-publication)
- <a id="prepare-and-stabilize-the-candidate" />[Prepare and stabilize the candidate](/reference/releasing/extended-stable#prepare-and-stabilize-the-candidate)
- <a id="publish-the-npm-packages" />[Publish the npm packages](/reference/releasing/extended-stable#publish-the-npm-packages)
- <a id="verify-and-recover" />[Verify and recover](/reference/releasing/extended-stable#verify-and-recover)
- <a id="regular-release-operator-checklist" />[Regular release operator checklist](/reference/releasing/regular-release#regular-release-operator-checklist)
- <a id="stable-main-closeout" />[Stable main closeout](/reference/releasing/main-closeout#stable-main-closeout)
- <a id="release-preflight" />[Release preflight](/reference/releasing/preflight#release-preflight)
- <a id="release-test-boxes" />[Release test boxes](/reference/releasing/test-boxes#release-test-boxes)
- <a id="vitest" />[Vitest](/reference/releasing/test-boxes#vitest)
- <a id="docker" />[Docker](/reference/releasing/test-boxes#docker)
- <a id="qa-lab" />[QA Lab](/reference/releasing/test-boxes#qa-lab)
- <a id="package" />[Package](/reference/releasing/test-boxes#package)
- <a id="regular-release-publish-automation" />[Regular release publish automation](/reference/releasing/publish-automation#regular-release-publish-automation)
- <a id="npm-workflow-inputs" />[NPM workflow inputs](/reference/releasing/npm-workflow-inputs#npm-workflow-inputs)
- <a id="regular-beta%2Flatest-stable-release-sequence" />[Regular beta/latest stable release sequence](/reference/releasing/beta-latest-sequence#regular-beta%2Flatest-stable-release-sequence)
- <a id="regular-beta/latest-stable-release-sequence" />[Regular beta/latest stable release sequence](/reference/releasing/beta-latest-sequence#regular-beta/latest-stable-release-sequence)

## Public references

- [`.github/workflows/full-release-validation.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/full-release-validation.yml)
- [`.github/workflows/package-acceptance.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/package-acceptance.yml)
- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`.github/workflows/openclaw-release-checks.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-release-checks.yml)
- [`.github/workflows/openclaw-cross-os-release-checks-reusable.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-cross-os-release-checks-reusable.yml)
- [`.github/workflows/docker-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/docker-release.yml)
- [`scripts/resolve-openclaw-package-candidate.mts`](https://github.com/openclaw/openclaw/blob/main/scripts/resolve-openclaw-package-candidate.mts)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)

Maintainers use the private release docs in [`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md) for the actual runbook.

## Related

- [Release channels](/install/development-channels)
