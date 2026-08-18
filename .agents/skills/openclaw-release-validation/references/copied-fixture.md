# Copied fixture preparation

Use this sequence for copied-state release validation. The source stays
untouched; every repair or compatibility workaround belongs only to the fixture
and must be recorded as a finding.

## 1. Create the durable run ledger

Create `<run-root>/run.json` before stopping any gateway. Record the candidate,
source, env name, source running state, artifact paths, stopped-gateway restore
obligations, fixture-only config/plugin changes, findings, mission results, and
cleanup status. Update it immediately after each mutation so another session
can resume or clean up safely.

## 2. Stage the source

Stop the selected source first only when copied channel credentials may become
active. Record whether this run must restore it. Then run the staging helper as
one standalone long-running command and wait for its JSON receipt:

```sh
node .agents/skills/openclaw-release-validation/scripts/release-validation.mts stage-copy \
  --source <selected-.openclaw> \
  --destination <run-root>/source-state
```

The helper uses `rsync`, excludes Unix sockets, verifies the regular copy, and
rewrites exact source-root references in the copied top-level config. It
refuses an existing destination; use a fresh run-owned path instead of merging
with a partial copy. Never use `ditto` for live OpenClaw state and never chain
copy and import in one shell command.

## 3. Import and upgrade

Run import by itself and wait for completion. A large state tree can remain
quiet for minutes; silence or a detached tool wait is not a receipt. Afterward,
read back `ocm env status`, `ocm env resolve`, and `ocm service status`.

```sh
ocm adopt import --name <env> --root <run-root>/env <run-root>/source-state --json
ocm upgrade <env> --runtime <verified-exact-runtime> --dry-run --json
ocm upgrade <env> --runtime <verified-exact-runtime> --json
```

If OCM rejects an absolute workspace or config include, repair only the copied
config and retry. Do not broadly rewrite transcripts, logs, or the source. After
import, confirm active workspace and plugin paths resolve inside the run root.

## 4. Normalize and preflight before start

A copied remote-client config cannot host the validation gateway. Set local
mode only in the fixture, then check plugins before any channel can connect:

```sh
ocm @<env> -- config set gateway.mode local
ocm @<env> -- config get agents.defaults.workspace
ocm @<env> -- config get plugins.load.paths
ocm @<env> -- plugins list --json
ocm @<env> -- plugins update --all --dry-run
```

Treat plugin load or SDK incompatibility as a release finding. Prefer the
supported plugin updater when it offers a compatible version. If it cannot
repair the fixture, ask whether to disable only that fixture plugin so other
missions can continue; record the exact version pair and workaround.

Enforce the **single-owner channel safety rule** before start. Compare enabled
channel credential fingerprints with every listening gateway without printing
secret values. Report only channel, gateway, and match/no-match. Ask before
stopping a gateway not already selected as the source, and add it to
`run.json` for restoration. If `ocm service stop` leaves an external listener,
prove the exact PID belongs to that env before asking to terminate it; never
kill an ambiguous process.

## 5. Start and prove readiness

Start only after path, plugin, and channel-owner checks pass:

```sh
ocm service start <env>
ocm service status <env> --json
ocm @<env> -- --version
ocm @<env> -- gateway probe --json
ocm logs <env> --tail 100 --json
```

Also read the assigned port from OCM and require its `/healthz` response. Do not
substitute broad `status` when copied credentials lack `operator.read`;
`gateway probe` is the narrower authenticated reachability proof.

## 6. Restore

On pause, stop, failure, or cleanup, update `run.json` first. Stop the fixture
before restoring any prior credential owner. Restore every gateway to its
recorded prior desired state, confirm its listener/readiness, and list any
retained run-owned resources explicitly.
