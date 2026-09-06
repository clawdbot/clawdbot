# Package And Docker Proof

Read for installable-package behavior, plugin package trust, targeted Docker or
live lanes, and failed-lane reruns. Release decisions and full-validation
recovery belong to `$release-openclaw-ci`; plugin release coverage belongs to
`$release-openclaw-plugin-testing`. Apply the entrypoint's source-trust and
operator-state boundaries before any execution.

## Candidate Identity

`Package Acceptance` (`.github/workflows/package-acceptance.yml`) tests an
installable candidate using a trusted harness. Inspect its current inputs
before dispatch; source selection is not permission to run untrusted bytes with
credentials.

- `source=npm`: select the requested dist-tag or exact OpenClaw release version.
  Resolve current tags with `npm view openclaw dist-tags --json --prefer-online`
  and record the selected version, tarball, and integrity. Pin exact versions
  for reruns or comparisons. If the requested beta is missing, stale, or broken,
  report it; do not silently substitute `latest`.
- `source=ref`: `package_ref` selects trusted product source; `workflow_ref`
  selects the trusted harness. The `gh workflow run --ref` revision selects the
  workflow definition and is a separate identity.
- URL/artifact sources: supply the workflow's required SHA-256 and immutable
  artifact/provenance fields. Read the input contract rather than reconstructing
  it from an older command. Never treat a URL or artifact label as trust proof.

Select a bounded `suite_profile`: `smoke` for installation/onboarding confidence,
`package` for install/update and package contracts, `product` for broader product
flows, or `custom` with exact `docker_lanes` for recovery. Inspect current
profiles for Telegram or full-release coverage. Optional Telegram QA consumes
the same resolved tarball; `mock-openai` mocks the model, not the Telegram
credential boundary. Skipping it is appropriate only when outside the selected
proof scope.

Package Acceptance is a shard of release validation, not a second release
orchestrator. The caller owns release identity, secret policy, blocking status,
and evidence rollup.

## Plugin Package Trust

Local candidate proof uses
`openclaw plugins install npm-pack:<path.tgz> --force` to exercise the managed
per-plugin npm project. Raw archive/path installs do not prove that dependency
path. `npm-pack:` also does not prove catalog-linked official trust: add a
catalog-backed official or published install when privileged helpers or
trusted-official scope handling is the behavior under test.

Inspect the tarball's manifest, runtime files, bundled dependency payload when
enabled, and absence of npm lockfiles when package ownership or generated output
changes. Runtime imports belong in the plugin's `dependencies` or
`optionalDependencies`; manually installing into the managed npm project cannot
be final proof. Dependency-section changes also need the transient package-lock
check. Restart only the task-owned or explicitly approved Gateway when testing
new plugin registration, dependency loading, privileged helpers, routing, or
built output. Remove temporary probe config and verify cleanup.

## Docker And Live Lanes

Prefer the prepared GitHub workflow for Docker/release proof. Select
`docker_lanes` in `openclaw-live-and-e2e-checks-reusable.yml` and disable unrelated
live, repository E2E, and release-path suites where the selected lane permits.
For model selection, use `live_models_only=true` plus a specific
`live_model_providers` allowlist; verify logs show the selected providers/models.
For native live shards, `node scripts/test-live-shard.mjs <shard> --list` shows
exact files. Read workflow inputs for current shard names instead of maintaining
a separate catalog here.

Inspect the scheduler before allocating expensive proof:

```bash
OPENCLAW_DOCKER_ALL_LANES=<lane> node scripts/test-docker-all.mjs --plan-json
```

The scenario catalog `scripts/lib/docker-e2e-scenarios.mjs` owns lanes;
`scripts/lib/docker-e2e-plan.mjs` owns image/package/credential requirements.
The functional image installs the same prebuilt tarball mounted by bare lanes;
repo sources are not the installed application. The canonical packer is
`scripts/package-openclaw-for-docker.mjs`.

For container Gateway UI proof, use `scripts/docker/setup.sh` and
`docs/install/docker.md` with isolated paths and a free port. Compose defaults
mount the operator's `~/.openclaw` and claim port 18789; do not reuse them for
proof. The setup script seeds allowed browser origins for the published port.

For skill installation, prefer `pnpm test:docker:skill-install` or the
`skill-install` lane: it resolves a live ClawHub slug and verifies origin/lock
metadata with uploaded archives disabled.

## Rerun From Evidence

Read the failed lane's log, `summary.json`, and `failures.json` under
`.artifacts/docker-tests/`. Use measured phase/lane timings instead of historical
estimates:

```bash
pnpm test:docker:timings <summary.json>
pnpm test:docker:rerun <github-run-id>
pnpm test:docker:rerun .artifacts/docker-tests/<run>/failures.json
```

The rerun helper prints targeted combined and per-lane workflow commands. Review
and run the smallest command covering the failure. It repacks the exact artifact
target SHA; a default-branch workflow definition is a separate identity.
`OPENCLAW_DOCKER_E2E_WORKFLOW_REF` explicitly selects another trusted definition.
An explicit target override drops image reuse unless artifacts prove the image
belongs to that SHA.

Prepared GHCR images permit `shared_image_policy=existing-only` only with their
explicit image refs. Runner-local artifact images are rebuilt on a fresh rerun.
Do not disable build/preflight against arbitrary images to make a command pass.
A local `rerunCommand` is a starting point when local Docker is explicitly
requested or GitHub is unusable; it still requires the selected package and
images. Reassess after a narrow retry rather than automatically rerunning the
whole release matrix.
