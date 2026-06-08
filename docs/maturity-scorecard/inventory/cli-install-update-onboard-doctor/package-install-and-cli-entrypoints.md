---
title: CLI - CLI Setup Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - CLI Setup Maturity Note

## Summary

OpenClaw exposes multiple documented install paths for normal operators: hosted
installer scripts, local-prefix installs, global package-manager installs,
source-checkout usage, and explicit Node runtime guidance. Coverage is solid for
the documented launcher and runtime expectations, but the repo still does not
contain broad end-to-end validation for published installer and environment
matrix combinations.

## Category Scope

This category covers how a user gets the CLI onto a machine, satisfies the
supported runtime expectations, and verifies that the root `openclaw` command
starts, prints help, and reports version. It does not cover onboarding choices
or managed gateway service operations.

## Features

- Installer scripts: Hosted installer scripts set up Node, install OpenClaw, and optionally start onboarding.
- Local prefix install: The local-prefix installer keeps Node and OpenClaw under a dedicated OpenClaw directory instead of relying on a system-wide runtime.
- Package-manager installs: npm, pnpm, and bun global installs are supported when the operator manages Node directly, including PATH wiring expectations.
- Supported Node runtime: OpenClaw documents the supported Node versions and recommended runtime before normal CLI workflows continue.
- Source checkout install: Operators can run OpenClaw from a source checkout for development or recovery workflows, and update flows distinguish this path from package installs.
- CLI entrypoint: The packaged openclaw launcher, openclaw --help, openclaw --version, runtime preflight, and basic recovery expectations are documented.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals:
  - The install landing page documents hosted installers, local-prefix installs, npm/pnpm/bun globals, and source-checkout flows in `docs/install/index.md`.
  - The installer reference documents `install.sh`, `install-cli.sh`, and `install.ps1`, including Windows automation flags, in `docs/install/installer.md`.
  - `docs/install/node.md` documents Node 24 as recommended and Node 22.19+ as supported, plus PATH and permission recovery paths.
  - `docs/install/updating.md` documents switching between package installs and git/source installs.
  - Root CLI entrypoint fast paths are covered in `src/entry.ts`, `src/entry.version-fast-path.ts`, `src/entry.test.ts`, and `src/version.test.ts`.
  - Respawn behavior that preserves help/version usability across launcher edge cases is exercised in `src/entry.respawn.test.ts`.
  - Install-kind and package-manager detection logic exists in `src/cli/update-cli/shared.ts`, `src/cli/install-spec.ts`, `src/infra/install-target.ts`, and `src/bootstrap/node-extra-ca-certs.ts`.
- Negative signals:
  - No repo-local integration or e2e tests were found for the hosted installer scripts from a clean machine state.
  - Local-prefix install behavior is well documented, but proof is mainly docs plus support utilities rather than a dedicated automated flow.
  - Most runtime-path proof is static docs plus unit tests rather than a broad matrix of package-manager and version-manager combinations.
- Integration gaps:
  - No automated macOS/Linux/Windows smoke that runs the published installer scripts and validates the resulting CLI binary was found.
  - No broad e2e matrix was found validating npm/pnpm/bun plus version-manager combinations across macOS/Linux/Windows.

## Quality Score

- Score: `Beta (75%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "install.ps1 install.sh npm pnpm bun openclaw install" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned `[]`.
  - Query `gitcrawl search issues "install.sh install.ps1 local prefix npm pnpm bun" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5` returned `[]`.
  - Query `gitcrawl search issues "Node version package manager pnpm bun npm runtime openclaw" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned `[]`.
  - Query `gitcrawl search issues "node 24 pnpm bun install docs" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5` returned `[]`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "install.ps1 openclaw install"` returned recent user-help guidance pointing people at `install.ps1` and the site install instructions.
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "Node pnpm bun npm openclaw"` surfaced a docs PR and discussion clarifying Bun install support and gateway-runtime recommendations.
- Good qualities:
  - The install matrix is explicit and operator-facing instead of forcing one hidden path.
  - Root help/version fast paths reduce startup cost and keep the CLI usable even when the full runtime tree is not needed.
  - Source-checkout and package-manager paths are both first-class in docs.
  - Supported runtime expectations are explicit instead of implicit.
  - Update/install logic distinguishes git checkouts from package installs rather than treating all roots identically.
- Bad qualities:
  - Installer quality still depends heavily on external shell, PATH, and package-manager environment state.
  - Windows installer verbosity is still limited according to the installer docs.
  - Operator outcomes still depend on external runtime managers, PATH setup, and system package-manager behavior.
- Excluded from quality:
  - `src/entry.test.ts`, `src/version.test.ts`, `src/entry.respawn.test.ts`, `src/bootstrap/node-extra-ca-certs.test.ts`, `src/infra/detect-package-manager.test.ts`, and `src/infra/install-target.test.ts` provide coverage corroboration only.

## Known Gaps

- Hosted installer scripts lack main-repo e2e proof.
- Local-prefix install behavior would benefit from an explicit automated smoke path.
- No environment-matrix integration proof for runtime and package-manager combinations.
- PATH and version-manager behavior is still mostly guarded by docs and utility tests.

## Evidence

### Docs

- `docs/install/index.md`
- `docs/install/installer.md`
- `docs/install/node.md`
- `docs/install/updating.md`

### Source

- `src/entry.ts`
- `src/entry.version-fast-path.ts`
- `src/version.ts`
- `src/bootstrap/node-extra-ca-certs.ts`
- `src/cli/update-cli/shared.ts`
- `src/cli/install-spec.ts`
- `src/infra/install-target.ts`

### Integration tests

- None found for published installer-script execution or cross-package-manager runtime setup.

### Unit tests

- `src/entry.test.ts`
- `src/entry.respawn.test.ts`
- `src/version.test.ts`
- `src/bootstrap/node-extra-ca-certs.test.ts`
- `src/infra/detect-package-manager.test.ts`
- `src/infra/install-target.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "install.ps1 install.sh npm pnpm bun openclaw install" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`
- `gitcrawl search issues "install.sh install.ps1 local prefix npm pnpm bun" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5`
- `gitcrawl search issues "Node version package manager pnpm bun npm runtime openclaw" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`
- `gitcrawl search issues "node 24 pnpm bun install docs" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5`

Results:

- `[]`
- `[]`
- `[]`
- `[]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "install.ps1 openclaw install"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "Node pnpm bun npm openclaw"`

Results:

- Recent help-thread guidance points users at `powershell -c "irm https://openclaw.ai/install.ps1 | iex"` and the site install flow.
- April Discord archive results include docs work to clarify Bun install support and that Node remains the recommended gateway runtime.
