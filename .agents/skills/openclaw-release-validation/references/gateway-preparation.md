# Prepare the selected gateway

Gateway discovery does not require OCM. Check whether `ocm` is available. If it
is, read `ocm --version` and discover managed environments once with `ocm env
list --json`; otherwise continue without installing it. In parallel, inspect
the plain personal gateway with `openclaw --version` and `openclaw gateway
status --json --no-probe`. When OCM is available, also use `ocm adopt inspect
~/.openclaw --json` to resolve aliases safely.

Read only each gateway's display name, OpenClaw version, and running/stopped
state. Do not expose commands, paths, configuration, credentials, plugins, or
other internals. If the plain home's resolved path is an OCM environment's
`stateDir`, show it once as that environment's personal-state alias. Otherwise
show `Personal ~/.openclaw` with its known version and state. Ask which gateway
the tester wants to use. Never silently select or modify the personal gateway.

After selection, inspect only that gateway and record its version and commit.
Then ask:

```text
How should I test this gateway?

1. Use an isolated OCM copy (recommended) — tests a disposable copy and fails
   closed if OCM cannot prove candidate-writable paths stay inside it.
2. Update the selected gateway in place — changes this real gateway to the
   latest main build, restarts it, and may update its plugins and state.

Reply exactly `use isolated OCM copy` or `update selected gateway in place`.
```

Do not infer the mode. The second reply selects the in-place lane but does not
yet authorize mutation; show its backup/snapshot and dry-run result first, then
obtain the separate approval required below.

### Isolated OCM copy

If OCM is unavailable only after the tester chooses isolation, say:

```text
OCM is required for the isolated-copy option and is not installed.

Reply exactly `install OCM` to let me install the OpenClaw Manager CLI, or
install it yourself and reply `OCM installed`.
```

Install OCM only after `install OCM`, using the official installer, then verify
it before continuing:

```sh
curl -fsSL https://github.com/openclaw/ocm/releases/latest/download/install.sh | bash
ocm --version
```

If the binary lands in `~/.local/bin` outside the current PATH, use its absolute
path for this run and tell the tester how to update future shells. On an install
or verification failure, report the exact error and pause. Never replace OCM
with a manual state copy.

If the source is already an OCM environment, clone it through OCM. If the
source is the plain personal gateway, preview and import that plain home:

```sh
ocm env clone <source-env> <test-env> --json
# Plain source only:
ocm adopt plan --name <test-env> ~/.openclaw --json
ocm adopt import --name <test-env> ~/.openclaw --json
```

Do not import an OCM environment through its underlying state path. Let OCM
create the stopped environment and assign a non-conflicting port; do not make
an additional staged copy. Use the returned environment name in every command.
If OCM cannot isolate an include, workspace, or source path, pause and report
that setup blocker conversationally. Never make a manual copy or put an OCM
setup failure in campaign feedback.

Treat containment as a hard gate, not a warning. Capture stderr even when using
`--json`. If adopt/import reports `could not be isolated inside the env state`,
or clone/import/plugin inventory reveals any absolute plugin install or source
path outside the target environment, do not build, upgrade, or start the
candidate. Do not normalize or copy the path manually. State that OCM isolation
could not be proven and offer the tester the mode choice again, including the
explicit in-place lane. This protects against the unresolved source-state escape
tracked in `openclaw/ocm#98`.

Before activating copied channel credentials, obtain explicit per-task
approval to stop their current owner unless already authorized. Stop that owner
and restore it when validation ends. For an OCM source, use `ocm service
stop <source-env>`; for the plain source, use `openclaw gateway stop`. There is
no `ocm stop` command.

### In-place gateway

Do not copy the selected gateway. A plain gateway will use its own `openclaw`
CLI and a managed OCM environment will use that environment's OCM commands.
Do not install OCM merely for a plain in-place update. Do not stop another
credential owner: this gateway keeps ownership while its own service restarts.

## Prepare the immutable main target

For every **Validate release** run, resolve a fresh immutable main target after
the campaign issue and test mode are known. Never use the caller's active
checkout. Resolve exactly one SHA. For either OCM lane, also create a run-owned
isolated checkout at that SHA and prove it did not move:

```sh
main_sha="$(git ls-remote https://github.com/openclaw/openclaw.git refs/heads/main | awk 'NR == 1 { print $1 }')"
test "$(printf '%s' "$main_sha" | wc -c | tr -d ' ')" = 40
main_checkout="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-validation-main.XXXXXX")"
git -C "$main_checkout" init -q
git -C "$main_checkout" remote add origin https://github.com/openclaw/openclaw.git
git -C "$main_checkout" fetch --depth 1 origin "$main_sha"
git -C "$main_checkout" checkout --detach -q FETCH_HEAD
test "$(git -C "$main_checkout" rev-parse HEAD)" = "$main_sha"
```

If main resolution, fetch, checkout, or SHA verification fails, report the setup
blocker conversationally and pause. Do not fall back to a moving branch, caller
checkout, or current beta package.

### OCM isolated or OCM-managed in-place lane

Give the run-owned runtime a unique name containing the short main SHA and a UTC
timestamp, then build and verify the exact checkout:

```sh
ocm runtime build-local <run-runtime-name> --repo <main-checkout> --force
ocm runtime verify <run-runtime-name>
ocm upgrade <test-env> --runtime <run-runtime-name> --dry-run --json
```

For an OCM-managed in-place gateway, explain that OCM will create a pre-upgrade
snapshot and retain a rollback transaction. Show the dry-run summary, then wait
for the tester to reply exactly `approve in-place update`. Without that reply,
do not mutate or start anything. The isolated lane needs no additional approval.

Then run:

```sh
ocm upgrade <test-env> --runtime <run-runtime-name> --json
ocm service start <test-env>
```

In the isolated lane, stop any current owner of copied channel credentials
immediately before `ocm service start`. Skip the explicit start when the upgrade
already preserved a running service. Verify `ocm service status <test-env>`,
`ocm @<test-env> -- --version`, and `ocm logs <test-env> --tail 100`. OCM's
successful managed upgrade already requires HTTP health and gateway
reachability.

### Plain in-place lane

First inspect `openclaw update status --json`. Create a full verified backup in
a private owner-only directory outside `~/.openclaw`, retain its resulting
archive path, and never expose that path in GitHub output:

```sh
openclaw backup create --output <private-backup-dir> --verify
OPENCLAW_UPDATE_DEV_TARGET_REF="$main_sha" openclaw update --channel dev --dry-run --json
```

Explain that the update switches this real installation to the dev channel,
builds the pinned main commit, may migrate state and plugins, and restarts the
gateway. Show the verified backup result and dry-run summary, then wait for the
tester to reply exactly `approve in-place update`. Without that reply, do not
mutate the gateway.

Apply and verify:

```sh
OPENCLAW_UPDATE_DEV_TARGET_REF="$main_sha" openclaw update --channel dev --yes --json
openclaw update status --json
openclaw --version
openclaw gateway status --json
openclaw plugins list --json
```

Require the update result to succeed, its `after.sha` and the status result's
Git SHA to equal `main_sha`, and the managed gateway to be healthy. If any are
missing or disagree, do not call the gateway ready.

For every lane, record `origin/main` and the full `main_sha` as the tested target
and commit. Keep the stable train, current beta tag, and beta commit separate.

Report every error immediately, including errors recovered by a retry. OpenClaw
config migration, update, plugin convergence, startup, and readiness failures
from the selected test target are eligible **Upgrade findings**. Add them to the
worksheet only when readiness is later verified. OCM tooling, copying, backup
plumbing, local build setup, and cleanup failures never enter the worksheet,
candidate finding drafts, campaign report, hidden payload, or Discord summary
details. On the first such failure, read and apply
[the tooling-feedback packet procedure](tooling-feedback.md). A
tooling-only blocker is not an Upgrade finding.

As soon as an eligible upgrade finding is concrete, run the related-issue
investigation in [human testing](human-testing.md) and queue its private draft. Do this before manual
surface testing; do not wait until wrap-up.

Complete this step only when test-target readiness is either verified or blocked
with a concrete terminal finding. Do not continue to testing while the upgrade
or gateway readiness is unresolved.

If candidate-owned readiness is **blocked**, this is a terminal
upgrade-validation result: skip optional diagnostics, the worksheet, and
surface testing. Do not create, open, mention, or
ask the tester to use a worksheet; there is no running gateway to test. State
plainly:

```text
Upgrade blocked — the selected test gateway never became ready, so manual surface testing cannot begin.
Reply exactly `finish validation` to prepare a reviewable report of this upgrade finding, or tell me any final feedback to include.
```

Then wait for final feedback or `finish validation`.

If tooling blocked preparation before candidate-owned readiness could be
evaluated, follow the tooling-feedback procedure instead. Do not use the
Upgrade finding prompt above or prepare candidate feedback.
