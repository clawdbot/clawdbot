---
summary: "When agents use Crabbox or Testbox, and the wrapper, lease, and trust rules"
title: "Remote test proof"
read_when:
  - You are deciding between local and remote proof
  - You are running OpenClaw tests on Crabbox or Testbox
---

## Agent default

Agent sessions run trusted development tests, changed gates, typecheck/lint,
and builds locally by default, broadening only when the touched contract
requires it. Never execute untrusted repository tooling locally. Use Crabbox
when the environment is part of the proof: clean-machine, install/package,
Docker, E2E, live, desktop, or cross-platform work, or when the operator
explicitly requests remote proof. Do not use Crabbox merely as generic compute
offload. The configured Testbox workflow hydrates credentials, so untrusted
contributor or fork code must use secretless fork CI or sanitized direct AWS
Crabbox instead.

Do not pre-warm for anticipated work. Acquire the backend lazily when the
first environment-sensitive command is ready, reuse the returned `tbx_...` id
for later remote commands, sync the current checkout on every run, and stop it
before handoff.

After the first successful reuse, the wrapper records the lease's base,
dependency, and Testbox workflow fingerprint under `.crabbox/testbox-leases/`.
Source-only edits keep reusing the warmed box. A changed merge base, lockfile,
package-manager input, wrapper, or Testbox workflow fails closed and requires a
fresh lease. Every run still syncs the current checkout.
`OPENCLAW_TESTBOX_ALLOW_STALE=1` is only for intentional diagnostics, not
release proof.

The Testbox workflow registers a separate disposable checkout for native sync.
The hydrated execution workspace stays at its original absolute path, so native
Git cleanup and rsync cannot delete dependencies, build output, or ignored runtime
there. The wrapper applies and verifies the source bundle in that execution
workspace, runs its frozen dependency install, and checks the source and Git
identity again before the payload. Install output goes to stderr; an install or
verification failure stops the payload. It never restores runtime from the caller
or changes the selected rsync binary.

Workspace preparation changes require a fresh lease. A missing or overlapping
execution-workspace binding stops the payload; stop that lease and warm a new one.
Use the OpenClaw wrapper for proof: direct native Blacksmith commands target the
transport checkout, which deliberately has no hydrated runtime.

Testbox requests with `--artifact-glob` or `--require-artifact` also require the
`prepared-artifact-workspace` feature in the selected Crabbox binary's
`providers describe blacksmith-testbox --json` response. The wrapper checks this
before sync or lease work, rather than collecting missing or stale transport files.
Update Crabbox if that capability is absent. Collection stays anchored in the
prepared workspace across payload directory changes and normal failure exits;
existing cancellation and signal-related artifact withholding remains unchanged.
Ordinary runs without artifact requests do not require this additional capability.

Testbox runs and POSIX remote changed gates freeze source into a Git bundle
against the pinned base. These runs require Crabbox 0.37.0 or later for
`sync-plan --json`; upgrade Crabbox before retrying an older binary. This API floor
does not apply to help, warmup, status, or runs that do not prepare a source bundle.
Selection uses Crabbox's sync policy and Git's repository, info, and effective global
exclusions, including repo-local overrides, for untracked files. Tracked ignored
files and staged ignored additions remain source; an explicit privacy exclusion
conflicting with required tracked source stops the run before upload.

The command binds the bundle digest and raw source tree. Before running the payload,
the receiver applies deletions and restores file bytes, symlink target bytes, and
Git executable modes, then verifies the filesystem directly. Git text filters do not
normalize this snapshot. Missing, stale, or mismatched bundles fail closed.
Producer-declared deletions must also be absent, even when the remote index has lost
them. Deletions use the same privacy policy as source selection; unknown ignored
runtime data is preserved. Unexpected nonignored receiver files stop the run instead
of being deleted. The verification receipt reports the original source revision
separately from the synthetic transport commit; remote `HEAD` identifies that
verified transport tree, and changed gates compare it with the pinned base.
Raw-byte differences can conservatively select additional changed paths. Git path
names must be UTF-8; symlink targets remain raw bytes. Symlinked repository Crabbox
configuration or ignore files, and privacy-excluded runtime configuration, are
rejected before upload rather than changing their trust or privacy treatment.

The [local test commands](/reference/test/local) are the normal trusted development path. Keep proof
proportional to the touched contract.

For untrusted proof, lazily warm with `--provider aws`. Every run must set
`CRABBOX_ENV_ALLOW=CI`, pass `--provider aws --no-hydrate`, and use
a fresh temporary remote `HOME` before installing dependencies or running
tests. Use a newly warmed lease dedicated to that untrusted source; never reuse
a trusted or previously hydrated lease. Launch an installed trusted Crabbox
binary from a clean trusted `main` checkout and fetch only the remote PR with
`--fresh-pr`; never execute the untrusted checkout's wrapper or config locally.
Unset `CRABBOX_AWS_INSTANCE_PROFILE` and fail closed unless resolved
`aws.instanceProfile` is empty. Before any install/test, use trusted
absolute-path tools to require an IMDSv2 token, prove the IAM credentials
endpoint returns 404, and verify remote `git rev-parse HEAD` equals the full
reviewed PR head SHA. Bind the lease to that SHA and stop/rewarm when the head
changes. Upload trusted `scripts/crabbox-untrusted-bootstrap.sh` from clean
`main` alongside `--fresh-pr`; it installs pinned Node/pnpm, verifies the SHA
and package-manager pin, isolates `HOME`, installs dependencies, then executes
the requested test. If the broker cannot prove no role or no remote PR exists,
use secretless fork CI. Do not use `hydrate-github`, `--no-sync`, or a
credential-hydrated Testbox workflow.
Unset all `CRABBOX_TAILSCALE*` overrides, force `--network public
--tailscale=false`, clear exit-node/LAN flags, and require `crabbox inspect` to
report public networking with no Tailscale state before uploading any script.

## Crabbox repository setup

The shared [Crabbox skill](https://github.com/openclaw/agent-skills/tree/main/skills/crabbox)
owns portable lease, trust, sync, and cleanup procedures. This section owns the
OpenClaw wrapper and workflow inputs. Routine task-needed Crabbox/Testbox use
and task-owned worktrees do not require another confirmation; preserve unrelated
work and existing credential, production, budget, and publication boundaries.

Run trusted OpenClaw remote proof through the wrapper from the repository root:

```bash
node scripts/crabbox-wrapper.mjs run --help
```

Read `.crabbox.yaml` and the resolved provider before running. The repository
default is `blacksmith-testbox`, with `.github/workflows/ci-check-testbox.yml`
owning its prepared environment. Direct providers use
`.github/workflows/crabbox-hydrate.yml`. Keep the resolved provider unless the
requested proof requires another environment; capacity or hydration failure
does not make a different provider equivalent.

The direct `.github/workflows/windows-blacksmith-testbox.yml` workflow runs
native Windows. The wrapper's Blacksmith adapter supports Linux only; explicit
`--provider blacksmith-testbox` prevents automatic Azure routing but does not
enable Windows support. Blacksmith CLI 0.4.57 targets `runner` and has no native
username override, so supported CLI sync/run on this Windows image remains
blocked. Native SSH inspection with the per-Testbox key is not CLI end-to-end
proof.

The wrapper checks an executable sibling `../crabbox/bin/crabbox`, then `PATH`,
then the sibling of the Git common checkout. Verify the selected binary and
its source rather than trusting a directory name. If it needs repair or is
missing, use a clean task-owned checkout of
[Crabbox](https://github.com/openclaw/crabbox), build `./cmd/crabbox` into a
task-owned binary directory, and leave other checkouts and the operator's
installed binary untouched. The existing
`OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY=1` setting skips the first sibling
candidate; a task binary on `PATH` then takes precedence over the common-checkout
candidate. A dirty or occupied sibling is not a reason to stop and ask.

For a selected trusted Testbox lane:

```bash
node scripts/crabbox-wrapper.mjs run --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 \
  OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm test <path-or-filter>
```

For several commands, warm once with
`node scripts/crabbox-wrapper.mjs warmup --keep --timing-json`, save the returned
lease ID, and reuse it with `run --id <tbx_id>`. Stop the owned lease with
`node scripts/crabbox-wrapper.mjs stop --id <tbx_id>`; stop has no `--timing-json`.

- Warm from the task checkout. Claims belong to checkout paths; `--reclaim`
  deliberately transfers that ownership and never changes repository identity.
  Sparse staging uses the wrapper's ownership path. Do not sync or reclaim
  while another command owns the lease.
- Wrapper reuse requires the local SSH key created by Crabbox. A missing key
  requires a fresh warmup. Leases created directly by Blacksmith remain usable
  through `blacksmith testbox run --id <tbx_id>`, not Crabbox wrapper reuse.
- Every native Testbox run syncs again, including reused leases. `--no-sync`
  cannot preserve a remote baseline. Compare revisions in separate remote
  worktrees within one synced command; never switch refs in the synced root.
- Compound remote shell commands use `bash -lc`, not `sh -lc`; hydration can
  depend on Bash declarations. Testbox's workflow owns Chromium, so do not pass
  Crabbox `--browser` to that provider.
- Keep the lease fingerprint checks described above. No stale-lease override
  for release proof. Direct-provider flags such as `--fresh-pr`, `--full-resync`,
  `--script*`, `--env-helper`, capture/download flags, and `--stop-after` are not
  a substitute for the delegated Testbox workflow.
- For Testbox scripts, run a synced file as trailing command arguments or use
  `--shell`. Active `--script` and `--script-stdin` uploads are rejected before
  source preparation or lease work.

When remote sync uses a temporary checkout, the wrapper preserves native
`.crabbox/runs` and `.crabbox/captures` outputs together beneath a fresh
`.crabbox/wrapper-artifacts/run-*` directory before removing that checkout.
Repeated runs retain separate evidence even when native filenames match. The
wrapper prints the old-to-new root mapping; native logs and generated proof may
still reference the old paths. A preservation error fails the wrapper and retains
the temporary checkout at the reported path for manual recovery, preserving the
child's nonzero exit code. The wrapper rejects symlinks in artifact trees
and destination parents, and copies only regular files and real directories.
Retained files use mode `0600` and new directories use `0700` on POSIX systems.
If preservation fails, recover the outputs from the reported checkout before
removing it; incomplete destination copies are removed.

These are local artifacts, not published or fully sanitized proof. Blacksmith's
native failure bundle contains captured stdout/stderr and diagnostic metadata;
it does not automatically include remote UI screenshots or reports. Retrieve
those separately before stopping the owned Testbox, and inspect all artifacts
for secrets and private data before sharing.

The native Windows Testbox idle monitor uses the running `sshd` service's local
listener ports, not Blacksmith's externally forwarded SSH port. Established SSH
connections keep the job alive; the `~/.testbox-last-activity` modification time
covers short commands between the 30-second polls. Once neither indicates recent
activity, the configured idle timeout still ends the job.

The shared skill's command placeholders map to the focused commands in this
guide. Its trusted bootstrap is `scripts/crabbox-untrusted-bootstrap.sh`; the
untrusted path above invokes the installed trusted CLI, never the PR's wrapper.
For an explicitly selected local-container lane, the existing example image is
`node:24-bookworm` and the install command is
`corepack pnpm install --frozen-lockfile --store-dir .pnpm-store`, followed by
the chosen test. Keep `--no-hydrate` and a repository-local dependency store
when host caches cannot cross filesystems. The OpenClaw broker login endpoint
is `https://crabbox.openclaw.ai`; normal brokered validation does not require
asking for AWS keys.

Live Gateway, channel, and agent-turn proof uses an isolated
`OPENCLAW_STATE_DIR`, a free port, and the real user path. Test-only plugin
artifacts may use `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1`; that does not make
them official installs. Before sharing WebVNC, inspect a screenshot of the
working app. Keep proof media out of the product repository and compare source
hashes before and after generator runs. If a final timing result is written but
portal synchronization hangs, interrupt only the task wrapper and independently
verify lease cleanup; never stop the operator's Gateway.
