---
name: blacksmith-testbox
description: Run Blacksmith Testbox for CI-parity checks, secrets, hosted services, migrations, or builds local cannot reproduce.
---

# Blacksmith Testbox

## Scope

Use Testbox when you need remote CI parity, injected secrets, hosted services,
or an OS/runtime image that your local machine cannot provide cheaply.

Do not default to Testbox for every local test/build loop. If the repo has
documented local commands for normal iteration, use those first so you keep
warm caches, local build state, and fast feedback.

Testbox is the expensive path. Reach for it deliberately.

OpenClaw maintainers can opt into Testbox-first validation by setting
`OPENCLAW_TESTBOX=1` in their environment or standing agent rules. This mode is
maintainers-only and requires Blacksmith access.

When `OPENCLAW_TESTBOX=1` is set in OpenClaw:

- Pre-warm a Testbox early for longer, wider, or uncertain work.
- Prefer Testbox for `pnpm` gates, e2e, package-like proof, and broad suites.
- Reuse the same Testbox ID for every run command in the same task/session.
- Use local commands only when the task explicitly sets
  `OPENCLAW_LOCAL_CHECK_MODE=throttled|full`, or when the user asks for local
  proof.

## Install the CLI

If `blacksmith` is not installed, install it:

    curl -fsSL https://get.blacksmith.sh | sh

For the canary channel (bleeding-edge):

    BLACKSMITH_CHANNEL=canary sh -c 'curl -fsSL https://get.blacksmith.sh | sh'

Then authenticate:

    blacksmith auth login

## Agent-triggered browser auth (non-interactive)

When an agent needs to ensure the user is authenticated before running testbox
commands (e.g. warmup, run), use browser-based auth with non-interactive mode.
This opens the browser for the user to sign in; the agent does not interact with
the browser. The org selector in the dashboard is skipped, so the user only sees
the sign-in flow.

**Required command** (`--organization` is required with `--non-interactive`):

    blacksmith auth login --non-interactive --organization <org-slug>

The org slug can come from `BLACKSMITH_ORG` env var or the `--org` global flag.
If neither is set, the agent should use the project's known org (e.g. from repo
config or user context). Example:

    blacksmith auth login --non-interactive --organization acme-corp
    blacksmith --org acme-corp auth login --non-interactive --organization acme-corp

**Flow**: The CLI starts a local callback server, opens the browser to the
dashboard auth page, and blocks for up to 2 minutes. The user completes sign-in
and authorization in the browser. The dashboard redirects to localhost with the
token; the CLI saves credentials and exits. The agent then proceeds.

**Do not use** `--api-token` for this flow — that is for headless/token-based
auth. This skill focuses on browser-based auth when the user prefers signing in
via the web UI.

Optional flags:

- `--dashboard-url <url>` — Override dashboard URL (e.g. for staging)

## Decide first: local or Testbox

Before warming anything up, check the repo's own instructions.

Prefer local commands when:

- the repo documents a supported local test/build workflow
- you are iterating on unit tests, lint, typecheck, formatting, or other
  local-only validation
- the value comes from warm local caches and fast repeat runs
- the command does not need remote secrets, hosted services, or CI-only images

Prefer Testbox when:

- the repo explicitly requires CI-parity or remote validation
- the command needs secrets, service containers, or provisioned infra
- you are reproducing CI-only failures
- you need the exact workflow image/job environment from GitHub Actions

For OpenClaw specifically, normal local iteration stays local unless maintainer
Testbox mode is enabled with `OPENCLAW_TESTBOX=1`:

- `pnpm check:changed`
- `pnpm test:changed`
- `pnpm test <path-or-filter>`
- `pnpm test:serial`
- `pnpm build`

If `OPENCLAW_TESTBOX=1` is enabled, run those same repo commands inside the
warm Testbox. If the user wants laptop-friendly local proof for one command, use
the explicit escape hatch `OPENCLAW_LOCAL_CHECK_MODE=throttled`.

For installable-package product proof, prefer the GitHub `Package Acceptance`
workflow over an ad hoc Testbox command. It resolves one package candidate
(`source=npm`, `source=ref`, `source=url`, or `source=artifact`), uploads it as
`package-under-test`, and runs the reusable Docker E2E lanes against that exact
tarball on GitHub/Blacksmith runners. Use `workflow_ref` for the trusted
workflow/harness code and `package_ref` for the source ref to pack when testing
an older trusted branch, tag, or SHA.

## Setup: Warmup before coding

If you decided Testbox is warranted, warm one up early. This returns an ID
instantly and boots the CI environment in the background while you work:

    blacksmith testbox warmup ci-check-testbox.yml
    # → tbx_01jkz5b3t9...

Save this ID. You need it for every `run` command.

For OpenClaw maintainer Testbox mode, pre-warm at the start of longer or wider
tasks:

    blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90

Use the build-artifact warmup when e2e/package/build proof benefits from seeded
`dist/`, `dist-runtime/`, and build-all caches:

    blacksmith testbox warmup ci-build-artifacts-testbox.yml --ref main --idle-timeout 90

Warmup dispatches a GitHub Actions workflow that provisions a VM with the
full CI environment: dependencies installed, services started, secrets
injected, and a clean checkout of the repo at the default branch.

In OpenClaw, raw commit SHAs are not reliable dispatch refs for `warmup --ref`;
use a branch or tag. The build-artifact workflow resolves `openclaw@beta` and
`openclaw@latest` to SHA cache keys internally.

Options:

    --ref <branch|tag>     Git ref to dispatch against (default: repo's default branch)
    --job <name>           Specific job within the workflow (if it has multiple)
    --idle-timeout <min>   Idle timeout in minutes (default: 30)

## CRITICAL: Always run from the repo root

ALWAYS invoke `blacksmith testbox` commands from the **root of the git
repository**. The CLI syncs the current working directory to the testbox
using rsync with `--delete`. If you run from a subdirectory (e.g.
`cd backend && blacksmith testbox run ...`), rsync will mirror only that
subdirectory and **delete everything else** on the testbox — wiping other
directories like `dashboard/`, `cli/`, etc.

    # CORRECT — run from repo root, use paths in the command
    blacksmith testbox run --id <ID> "cd backend && php artisan test"
    blacksmith testbox run --id <ID> "cd dashboard && npm test"

    # WRONG — do NOT cd into a subdirectory before invoking the CLI
    cd backend && blacksmith testbox run --id <ID> "php artisan test"

If your shell is in a subdirectory, `cd` back to the repo root first:

    cd "$(git rev-parse --show-toplevel)"
    blacksmith testbox run --id <ID> "cd backend && php artisan test"

## Running commands

    blacksmith testbox run --id <ID> "<command>"

The `run` command automatically waits for the testbox to become ready if
it is still booting, so you can call `run` immediately after warmup without
needing to check status first.

## Downloading files from a testbox

Use the `download` command to retrieve files or directories from a running
testbox to your local machine. This is useful for fetching build artifacts,
test results, coverage reports, or any output generated on the testbox.

    blacksmith testbox download --id <ID> <remote-path> [local-path]

The remote path is relative to the testbox working directory (same as `run`).
If no local path is specified, the file is saved to the current directory
using the same base name.

To download a directory, append a trailing `/` to the remote path — this
triggers recursive mode:

    # Download a single file
    blacksmith testbox download --id <ID> coverage/report.html

    # Download a file to a specific local path
    blacksmith testbox download --id <ID> build/output.tar.gz ./output.tar.gz

    # Download an entire directory
    blacksmith testbox download --id <ID> test-results/ ./results/

Options:

    --ssh-private-key <path>   Path to SSH private key (if warmup used --ssh-public-key)

## How file sync works

Understanding this model is critical for using Testbox correctly.

When you call `run`, the CLI performs a **delta sync** of your local changes
to the remote testbox before executing your command:

1. The testbox VM starts from a clean `actions/checkout` at the warmup ref.
   The workflow's setup steps (e.g. `npm install`, `pip install`, `composer install`)
   run during warmup and populate dependency directories on the remote VM.

2. On each `run`, the CLI uses **git** to detect which files changed locally
   since the last sync. It syncs ONLY tracked files and untracked non-ignored
   files (i.e. files that `git ls-files` reports).

3. **`.gitignore`'d directories are never synced.** This means directories
   like `node_modules/`, `vendor/`, `.venv/`, `build/`, `dist/`, etc. are
   NOT transferred from your local machine. The testbox uses its own copies
   of those directories, populated during the warmup workflow steps.

4. If nothing has changed since the last sync (same git commit and working
   tree state), the sync is skipped entirely for speed.

### Why this matters

- **Changing dependencies**: If you modify `package.json`, `requirements.txt`,
  `composer.json`, `go.mod`, or similar dependency manifests, the lock/manifest
  file will be synced but the actual dependency directory will NOT. You must
  re-run the install command on the testbox:

      blacksmith testbox run --id <ID> "npm install && npm test"
      blacksmith testbox run --id <ID> "pip install -r requirements.txt && pytest"
      blacksmith testbox run --id <ID> "composer install && phpunit"

- **Generated/build artifacts**: If your tests depend on a build step (e.g.
  `npm run build`, `make`), and you changed source files that affect the build
  output, re-run the build on the testbox before testing.

- **New untracked files**: New files you create locally ARE synced (as long as
  they are not gitignored). You do not need to `git add` them first.

- **Deleted files**: Files you delete locally are also deleted on the remote
  testbox. The sync model keeps the remote in lockstep with your local managed
  file set.

## CRITICAL: Do not ban local tests

Do not assume local validation is forbidden. Many repos intentionally invest in
fast, warm local loops, and forcing every run through Testbox destroys that
advantage.

Use Testbox for the checks that actually need it: remote parity, secrets,
services, CI-only runners, or reproducibility against the workflow image.

If the repo says local tests/builds are the normal path, follow the repo.

OpenClaw maintainer exception: if `OPENCLAW_TESTBOX=1` is set by the user or
agent environment, treat Testbox as the normal validation path for this repo.
Use `OPENCLAW_LOCAL_CHECK_MODE=throttled|full` as the explicit local escape
hatch.

## When to use

Use Testbox when:

- running database migrations or destructive environment checks
- running commands that depend on secrets or environment variables not present locally
- reproducing CI-only failures or validating against the workflow image
- validating behavior that needs provisioned services or remote runners
- doing a final parity check before commit/push when the repo or user wants that

Trim that list based on repo guidance. If the repo documents supported local
tests/builds, prefer local for routine iteration and keep Testbox for the
checks that need parity or remote state.

## Workflow

1. Decide whether the repo's local loop is the right default. For OpenClaw,
   `OPENCLAW_TESTBOX=1` makes Testbox the maintainer default.
2. If Testbox is warranted, warm up early:
   `blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90` → save the ID
3. Write code while the testbox boots in the background.
4. Run the remote command when needed:
   `blacksmith testbox run --id <ID> "pnpm check:changed"`
5. If tests fail, fix code and re-run against the same warm box.
6. If you changed dependency manifests (package.json, etc.), prepend
   the install command: `blacksmith testbox run --id <ID> "npm install && npm test"`
7. If you need artifacts (coverage reports, build outputs, etc.), download them:
   `blacksmith testbox download --id <ID> coverage/ ./coverage/`
8. Once green, commit and push.

## OpenClaw full test suite

For OpenClaw, use the repo package manager and the measured stable full-suite
profile below. It keeps six Vitest project shards active while limiting each
shard to one worker to avoid worker OOMs on Testbox:

    blacksmith testbox run --id <ID> "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test"

Observed full-suite time on Blacksmith Testbox is about 3-4 minutes:

- 173-180s on a warmed box
- 219s on a fresh 32-vCPU box

When validating before commit/push in maintainer Testbox mode, run
`pnpm check:changed` inside the warmed box first when appropriate, then the full
suite with the profile above if broad confidence is needed.

## Examples

    blacksmith testbox warmup ci-check-testbox.yml
    # → tbx_01jkz5b3t9...

    # Run tests
    blacksmith testbox run --id <ID> "npm test -- --testPathPattern=handler.test"
    blacksmith testbox run --id <ID> "go test ./pkg/api/... -run TestHandler -v"
    blacksmith testbox run --id <ID> "python -m pytest tests/test_api.py -k test_auth"

    # Re-install deps after changing package.json, then test
    blacksmith testbox run --id <ID> "npm install && npm test"

    # Build and test
    blacksmith testbox run --id <ID> "npm run build && npm test"

    # Download artifacts from the testbox
    blacksmith testbox download --id <ID> coverage/lcov-report/ ./coverage/
    blacksmith testbox download --id <ID> build/output.tar.gz

## Waiting for the testbox to be ready

The `run` command automatically waits for the testbox, so explicit waiting is
usually unnecessary. If you do need to check readiness separately (e.g. before
a series of runs), use the `--wait` flag. Do NOT use a sleep-and-recheck loop.

Correct: block until ready with a timeout:

    blacksmith testbox status --id <ID> --wait [--wait-timeout 5m]

Wrong: never use sleep + status in a loop:

    # BAD — do not do this
    sleep 30 && blacksmith testbox status --id <ID>
    while ! blacksmith testbox status --id <ID> | grep ready; do sleep 5; done

`--wait` polls the status and exits as soon as the testbox is ready (or when the
timeout is reached). Default timeout is 5m; use `--wait-timeout` for longer
(e.g. `10m`, `1h`).

## Managing testboxes

    # Check status of a specific testbox
    blacksmith testbox status --id <ID>

    # List all active testboxes for the current repo
    blacksmith testbox list

    # Stop a testbox when you're done (frees resources)
    blacksmith testbox stop --id <ID>

Testboxes automatically shut down after being idle (default: 30 minutes).
If you need a longer session, increase the timeout at warmup time. For OpenClaw
maintainer work, use 90 minutes for long-running sessions:

    blacksmith testbox warmup ci-check-testbox.yml --idle-timeout 90
    blacksmith testbox warmup ci-build-artifacts-testbox.yml --idle-timeout 90

## With options

    blacksmith testbox warmup ci-check-testbox.yml --ref main
    blacksmith testbox warmup ci-check-testbox.yml --idle-timeout 90
    blacksmith testbox run --id <ID> "go test ./..."
