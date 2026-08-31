---
name: crabbox
description: "Crabbox/Testbox remote proof: portable provider routing, untrusted isolation, Linux/macOS/Windows/WSL2, live E2E, diagnostics, cleanup."
---

# Crabbox

Remote and clean-machine proof. Packages. Docker. Live providers. Desktop.
Cross-OS. The consumer repository owns when its validation needs a remote
environment; Crabbox availability alone is not a reason to offload local work.

Backends:

- `blacksmith-testbox`: trusted maintainer source. Prepared CI. `tbx_...`.
- `aws`: direct brokered Crabbox. Fresh PRs. Custom sync/env/capture. `cbx_...`.
- `local-container`: Docker fallback. Not remote proof.
- `ssh`: existing operator host. macOS/Windows/WSL2.

Always report provider, id, run URL, command, result. Never call Testbox “AWS
Crabbox.”

## Repository Contract

This canonical skill owns portable Crabbox policy and CLI operations only.
Consumer-specific setup belongs in that repository's `AGENTS.md`, package
scripts, hydration workflow, or another file outside the synchronized skill.

Resolve these placeholders from trusted repository instructions before running
an example:

- `<check-command>`: the repository's focused or broad validation command.
- `<install-and-check-command>`: its clean-container install plus validation.
- `<trusted-bootstrap-script>`: a maintainer-reviewed untrusted-PR bootstrap
  stored outside the untrusted checkout.
- `<container-image>` and `<owner/repo#number>`: the consumer's runtime and PR.

Never invent a missing command or copy a command from another consumer.

## Authorization and Isolation

Routine use of the configured Crabbox/Testbox environment is part of completing
the requested task; do not ask for separate approval. This includes creating,
reusing and stopping task-owned leases, temporary state, and clean checkouts or
worktrees needed for proof or a task-required Crabbox repair.

A dirty, missing or occupied checkout is a reason to use a clean task-owned
checkout or worktree, not a permission blocker. Preserve existing checkouts,
branches and unrelated edits. Keep source-trust, credential, production-access,
budget and publication boundaries; routine-use approval does not waive them.

## Route First

Source trust determines which providers are allowed. It does not select one.

- Trusted development tests/checks/builds: follow the consumer's local-first
  policy; use remote when its environment is needed or explicitly requested.
- Trusted + remote proof: inspect and preserve the resolved provider.
- Blacksmith Testbox: use when already resolved or explicitly requested.
- Direct AWS: use when AWS semantics are required or explicitly requested.
- Untrusted contributor/fork: secretless fork CI or sanitized direct AWS.
- Never untrusted code on credential-hydrated Testbox.
- Never run untrusted repo wrapper/config locally.
- No speculative warmup. Acquire when first heavy command ready. Reuse id. Stop.

Test size, expected duration, and hydration failure do not authorize a provider
override. Omit `--provider` for normal work. Add it only when the user requests
that backend or the proof specifically tests its semantics.

## Preflight

Run from repo root.

```sh
command -v crabbox
crabbox --version
crabbox config show --json | jq '{provider, profile, target}'
crabbox run --help | sed -n '1,100p'
command -v blacksmith
blacksmith --version
```

Set the checked installed binary once. A consumer may document a different
trusted wrapper, but the shared skill never assumes a sibling checkout or
repository-specific script.

```sh
export CRABBOX="$(command -v crabbox)"
test -n "$CRABBOX"
"$CRABBOX" --version
"$CRABBOX" config show --json | jq '{provider, profile, target}'
```

Read `.crabbox.yaml` and `config show`; the resolved provider can also come from
user or environment configuration. If the binary is missing, follow the
consumer's trusted install instructions. For a source build or repair, verify
the canonical upstream and use a clean task-owned checkout or worktree. Never
assume a sibling checkout is trusted or overwrite its unrelated work. Keep
task-specific builds separate from the operator's installed binary.

## Trusted Testbox

Use this section only when `config show` resolves `blacksmith-testbox` or the
user explicitly requested Testbox. These provider-neutral commands preserve the
resolved configuration; add `--provider blacksmith-testbox` only for that
explicit override.

One-shot heavy gate:

```sh
"$CRABBOX" run --timing-json -- CI=1 <check-command>
```

Several commands: warm once, save id, reuse, stop.

```sh
"$CRABBOX" warmup --keep --timing-json
"$CRABBOX" run --id <tbx_id> --timing-json -- <check-command>
"$CRABBOX" stop <tbx_id>
```

Rules:

- One lease, one active command. No sync/reclaim during run.
- Native Testbox runs own sync, including reused `--id` runs. Never rely on
  `--no-sync` to preserve a remote baseline: Blacksmith has no native bypass,
  and released Crabbox versions can silently ignore the flag. An unchanged
  intentional rerun is not a Testbox exception.
- `--reclaim` only deliberate checkout-path ownership transfer.
- Base/head change: stop. Rewarm. No stale-lease override.
- Raw SHA unreliable for `warmup --ref`; use branch/tag.
- `blacksmith testbox list` hides states. Use `list --all` or
  `status --id <tbx_id>`.
- Testbox status/stop: `--id`. No status `--json`.
- Delegated provider rejects `--fresh-pr`, `--full-resync`, `--script*`,
  `--env-helper`, capture/download flags.

## Untrusted AWS

Clean trusted default-branch checkout. Installed trusted Crabbox binary. Fresh
lease per reviewed full head SHA. No instance role. No Tailscale. No hydration.
Only `CI` forwarded. Trusted bootstrap uploaded beside `--fresh-pr`.

```sh
cd <clean-trusted-default-branch-checkout>
env -u CRABBOX_AWS_INSTANCE_PROFILE \
  "$CRABBOX" config show --json | \
  jq -e '.aws.instanceProfile == ""' >/dev/null

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  -u CRABBOX_TAILSCALE \
  -u CRABBOX_TAILSCALE_AUTH_KEY \
  -u CRABBOX_TAILSCALE_AUTH_KEY_ENV \
  -u CRABBOX_TAILSCALE_EXIT_NODE \
  -u CRABBOX_TAILSCALE_EXIT_NODE_ALLOW_LAN_ACCESS \
  -u CRABBOX_TAILSCALE_HOSTNAME_TEMPLATE \
  -u CRABBOX_TAILSCALE_TAGS \
  "$CRABBOX" warmup \
  --provider aws --network public --tailscale=false \
  --tailscale-exit-node= \
  --tailscale-exit-node-allow-lan-access=false \
  --keep --timing-json

"$CRABBOX" inspect --provider aws --id <cbx_id> --json | \
  jq -e '.network == "public" and .tailscale == null' >/dev/null

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  CRABBOX_ENV_ALLOW=CI \
  "$CRABBOX" run \
  --provider aws --id <cbx_id> \
  --fresh-pr <owner/repo#number> \
  --no-hydrate --timing-json \
  --script <trusted-bootstrap-script> -- \
  <expected_full_head_sha> <check-command>

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  "$CRABBOX" stop --provider aws <cbx_id>
```

The consumer-owned bootstrap proves the IMDSv2 IAM credential endpoint returns
404, verifies the full SHA, removes inherited runtime injection variables,
pins the repository toolchain, isolates `HOME`, installs, and tests.

Head moved? Stop. Rewarm. No reuse across revisions. No remote PR or no-role
proof unavailable? Secretless fork CI. No exceptions.

## Direct AWS

Trusted direct run:

```sh
"$CRABBOX" run \
  --provider aws \
  --idle-timeout 90m --ttl 240m --timing-json \
  --shell -- \
  "<check-command>"
```

Focused:

```sh
"$CRABBOX" run \
  --provider aws --timing-json --shell -- \
  "<check-command>"
```

Stale sync: retry `--full-resync` once. Still bad: fresh lease. One-shot should
stop itself; after failure/interruption verify `"$CRABBOX" list --provider aws`.

Broker auth, not cloud keys:

```sh
"$CRABBOX" config show
"$CRABBOX" doctor
"$CRABBOX" whoami
"$CRABBOX" login --url <broker-url> --provider aws
```

Normal validation asking for AWS keys usually means wrong path.

## Fresh PR / Container

`--fresh-pr <owner/repo#123>`: clean remote checkout. Add `--apply-local-patch`
only for intentional local fixup. Direct providers only.

Use local Docker only when the resolved configuration selects it or the user
explicitly requests a local-container lane:

```sh
"$CRABBOX" run \
  --provider local-container \
  --local-container-image <container-image> \
  --no-hydrate --fresh-pr <owner/repo#number> \
  --timing-json --shell -- \
  "<install-and-check-command>"
```

Report `local-container`; not AWS/Testbox. Keep `--no-hydrate` and use a
repository-local dependency cache when host-mounted caches cannot cross filesystems.

## Observability

Prefer built-ins:

- `--preflight`: target/workspace/tool probes.
- `--debug --timing-json`: sync, command, total timing.
- `--script <file>` / `--script-stdin`: safe multiline direct-provider command.
- `--allow-env NAME` + `--env-from-profile <file>`: exact direct-provider env.
- `CRABBOX_ENV_ALLOW=NAME,...`: exact ambient env allowlist.
- `--capture-stdout`, `--capture-stderr`: direct-provider local capture.
- `--capture-on-fail`: test artifacts. Treat as secret-bearing until reviewed.
- `--keep-on-failure`: retain failed lease for debugging.
- `--results-auto` / `--junit <path>`: structured failure digest.
- `CRABBOX_PHASE:<name>` lines: phase timing.

Secrets: exact key only. One command. Never print. Never repo file. Never shell
history. No safe injection path? Report live auth blocked. No fake-key upgrade to
“live proof.”

## Real E2E

“Test in Crabbox” means user path, not merely remote unit tests.

1. Reproduce entrypoint when feasible.
2. Patch. Narrow local test.
3. Remote install/update/onboard/CLI/service/API path.
4. Record provider, id, command, environment shape, redacted secret source,
   observed result.
5. Cleanup.

Route:

- Install/package: pack tarball; install like user; matching Docker/package lane.
- Provider/auth: real provider. Scrub unrelated provider vars.
- Integration: setup, config, send/receive, and inspect redacted logs.
- Service/session/tool: real CLI or API; inspect persisted state and result.
- Parser/config: focused tests enough only when OS/package/service cannot matter.

Before/after: same Testbox when practical. Detached temp worktrees under `/tmp`.
Never checkout refs in synced root. For native Testbox, prepare and compare both
revisions within one synced invocation; later runs sync the local checkout again.
Full-screen CLI: real PTY. Interactive Clack: exact arrows/Enter; raw search
typing can lie.

Use the consumer's documented temporary state/config directory so proof cannot
mutate the operator's normal installation.

## Desktop / Cross-OS

Static hosts:

```sh
"$CRABBOX" run --provider ssh --target macos \
  --static-host <macos-host> -- <check-command>
"$CRABBOX" run --provider ssh --target windows --windows-mode normal \
  --static-host <windows-host> -- pwsh -NoProfile -Command '<check-command>'
"$CRABBOX" run --provider ssh --target windows --windows-mode wsl2 \
  --static-host <windows-host> -- <check-command>
```

Windows/WSL2: prefer Azure when advertised/configured. Native Windows uses
OpenSSH + PowerShell + Git + tar. Actions hydration Linux-only.

Brokered macOS: paid EC2 Mac. First quota/no-spend preflight. No silent
substitution for Linux proof.

```sh
"$CRABBOX" admin hosts quota --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --json
"$CRABBOX" admin hosts allocate --provider aws --target macos \
  --region eu-west-1 --type mac2.metal --dry-run --json
```

Human desktop: WebVNC preferred when the resolved provider supports it. Do not
change providers only to gain desktop support.

```sh
"$CRABBOX" warmup --desktop --browser --keep
"$CRABBOX" desktop launch --id <id> \
  --browser --url https://example.com --webvnc --open --take-control
"$CRABBOX" desktop doctor --id <id>
"$CRABBOX" webvnc status --id <id>
"$CRABBOX" artifacts collect --id <id> --all --output artifacts/<slug>
```

Before handoff, prove CLI/app from neutral `~`:

```sh
"$CRABBOX" run --id <id> --shell -- \
  "cd ~ && command -v <command> && <command> --version"
```

Visible desktop alone proves nothing. Keep browser windowed unless capture task.
Never commit proof assets to product repo.

## Failure Triage

Identify layer: wrapper, provider, hydration, sync, SSH, command.

```sh
"$CRABBOX" doctor
"$CRABBOX" status --id <id> --wait
"$CRABBOX" inspect --id <id> --json
"$CRABBOX" history --limit 20
"$CRABBOX" logs <run_id>
"$CRABBOX" results <run_id>
blacksmith testbox list --all
blacksmith testbox status --id <tbx_id>
```

- Provider/CLI old: follow the consumer's trusted Crabbox update path.
- Config/auth: `config show`, `doctor`, `whoami`.
- Sync quiet/stale: `--debug --timing-json`, then `--full-resync` once.
- Testbox capacity: no retry storm. Report the blocker; change providers only
  with explicit user approval.
- Command failure: read phase, failed test, JUnit, skipped shell segment. Focused
  rerun first.
- Cleanup unclear: list exact provider. Stop only owned ids.
- Consumer wrapper broken: use the installed Crabbox CLI only to isolate the
  wrapper, preserving the same resolved provider.

Crabbox stop does not accept `--timing-json`.

## Boundary

Crabbox stays generic: lease, sync, command, logs, results, timing, cleanup.
Consumer setup belongs in that repository's hydration workflow and scripts.
