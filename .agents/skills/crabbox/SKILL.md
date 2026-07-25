---
name: crabbox
description: "Crabbox/Testbox remote proof for OpenClaw: trusted-source routing, untrusted isolation, Linux/macOS/Windows/WSL2, live E2E, desktop, diagnostics, cleanup."
---

# Crabbox

Remote OpenClaw proof. Heavy tests. Builds. Typecheck/lint fan-out. Docker.
Packages. Live providers. Desktop. Cross-OS.

Backends:

- `blacksmith-testbox`: trusted maintainer source. Prepared CI. `tbx_...`.
- `aws`: direct brokered Crabbox. Fresh PRs. Custom sync/env/capture. `cbx_...`.
- `local-container`: Docker fallback. Not remote proof.
- `ssh`: existing operator host. macOS/Windows/WSL2.

Always report provider, id, run URL, command, result. Never call Testbox “AWS
Crabbox.”

## Route First

Source trust before test size.

- Trusted + one/few focused tests + ready deps: local.
- Trusted + heavy proof: Blacksmith Testbox.
- Untrusted contributor/fork: secretless fork CI or sanitized direct AWS.
- Never untrusted code on credential-hydrated Testbox.
- Never run untrusted repo wrapper/config locally.
- No speculative warmup. Acquire when first heavy command ready. Reuse id. Stop.

Need direct AWS semantics? Pass `--provider aws`. Need normal trusted OpenClaw
heavy proof? Pass `--provider blacksmith-testbox`.

## Preflight

Run from repo root.

```sh
command -v crabbox
../crabbox/bin/crabbox --version
node scripts/crabbox-wrapper.mjs run --help | sed -n '1,100p'
command -v blacksmith
blacksmith --version
```

Set checked binary once. PATH copy may be stale.

```sh
if [ -x ../crabbox/bin/crabbox ]; then
  export CRABBOX=../crabbox/bin/crabbox
else
  export CRABBOX="$(command -v crabbox)"
fi
"$CRABBOX" --version
```

Read `.crabbox.yaml`; never guess provider default.

No binary? Clean sibling checkout only:

```sh
if [ -n "$(git -C ../crabbox status --short)" ]; then
  git -C ../crabbox status --short
  exit 1
fi
git -C ../crabbox pull --ff-only
mkdir -p ../crabbox/bin
(cd ../crabbox && go build -o bin/crabbox ./cmd/crabbox)
../crabbox/bin/crabbox --version
```

Dirty/missing/nonstandard sibling: stop. No overwrite.

## Trusted Testbox

One-shot heavy gate:

```sh
node scripts/crabbox-wrapper.mjs run \
  --provider blacksmith-testbox \
  --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 \
  OPENCLAW_TEST_PROJECTS_PARALLEL=6 \
  OPENCLAW_VITEST_MAX_WORKERS=1 \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm check:changed
```

Several commands: warm once, save id, reuse, stop.

```sh
node scripts/crabbox-wrapper.mjs warmup \
  --provider blacksmith-testbox --keep --timing-json
node scripts/crabbox-wrapper.mjs run \
  --provider blacksmith-testbox --id <tbx_id> --timing-json -- \
  OPENCLAW_TESTBOX=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 \
  pnpm test <path-or-filter>
blacksmith testbox stop --id <tbx_id>
```

Rules:

- One lease, one active command. No sync/reclaim during run.
- Sync current checkout every run. `--no-sync` only unchanged intentional rerun.
- `--reclaim` only deliberate checkout-path ownership transfer.
- Base/head change: stop. Rewarm. No stale-lease override.
- Raw SHA unreliable for `warmup --ref`; use branch/tag.
- `blacksmith testbox list` hides states. Use `list --all` or
  `status --id <tbx_id>`.
- Testbox status/stop: `--id`. No status `--json`.
- Delegated provider rejects `--fresh-pr`, `--full-resync`, `--script*`,
  `--env-helper`, capture/download flags.

Autoreview parallel tests:

- Current helper: short POSIX test home. Nothing extra.
- Old helper + macOS `ControlPath too long`: put `TMPDIR=/tmp` on outer process.

```sh
TMPDIR=/tmp OPENCLAW_TESTBOX=1 "$AUTOREVIEW" \
  --parallel-tests "pnpm check:changed"
```

- Do not put `TMPDIR` inside quoted test command. Home already created.

## Untrusted AWS

Clean trusted `main` checkout. Installed trusted Crabbox binary. Fresh lease per
reviewed full head SHA. No instance role. No Tailscale. No hydration. Only `CI`
forwarded. Trusted bootstrap uploaded beside `--fresh-pr`.

```sh
cd <clean-trusted-openclaw-main>
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
  --script scripts/crabbox-untrusted-bootstrap.sh -- \
  <expected_full_head_sha> /usr/local/bin/pnpm test <path-or-filter>

env -u CRABBOX_AWS_INSTANCE_PROFILE \
  "$CRABBOX" stop --provider aws <cbx_id>
```

Bootstrap proves IMDSv2 IAM credential endpoint returns 404, verifies full SHA,
unsets `NODE_OPTIONS`, pins Node/pnpm, checks package-manager pin, isolates
`HOME`, installs, tests.

Head moved? Stop. Rewarm. No reuse across revisions. No remote PR or no-role
proof unavailable? Secretless fork CI. No exceptions.

## Direct AWS

Trusted direct run:

```sh
node scripts/crabbox-wrapper.mjs run \
  --provider aws \
  --idle-timeout 90m --ttl 240m --timing-json \
  --shell -- \
  "pnpm test:changed"
```

Focused:

```sh
node scripts/crabbox-wrapper.mjs run \
  --provider aws --timing-json --shell -- \
  "pnpm test <path-or-filter>"
```

Stale sync: retry `--full-resync` once. Still bad: fresh lease. One-shot should
stop itself; after failure/interruption verify `"$CRABBOX" list --provider aws`.

Broker auth, not cloud keys:

```sh
"$CRABBOX" config show
"$CRABBOX" doctor
"$CRABBOX" whoami
"$CRABBOX" login --url https://crabbox.openclaw.ai --provider aws
```

Normal validation asking for AWS keys usually means wrong path.

## Fresh PR / Container

`--fresh-pr <owner/repo#123>`: clean remote checkout. Add `--apply-local-patch`
only for intentional local fixup. Direct providers only.

No remote provider? Local Docker fallback:

```sh
node scripts/crabbox-wrapper.mjs run \
  --provider local-container \
  --local-container-image node:24-bookworm \
  --no-hydrate --fresh-pr openclaw/openclaw#123 \
  --timing-json --shell -- \
  "corepack pnpm install --frozen-lockfile --store-dir .pnpm-store && \
   corepack pnpm test <path-or-filter>"
```

Report `local-container`; not AWS/Testbox. `ERR_PNPM_EXDEV`: keep `--no-hydrate`
and repo-local store.

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
3. Remote install/update/onboard/Gateway/channel/agent-turn path.
4. Record provider, id, command, environment shape, redacted secret source,
   observed result.
5. Cleanup.

Route:

- Install/package: pack tarball; install like user; matching Docker/package lane.
- Provider/auth: real provider. Scrub unrelated provider vars.
- Channel: setup, config, Gateway, send/receive, redacted logs.
- Gateway/session/tool: real CLI or RPC; inspect state/API result.
- Parser/config: focused tests enough only when OS/package/service cannot matter.

Before/after: same Testbox when practical. Detached temp worktrees under `/tmp`.
Never checkout refs in synced root. Full-screen CLI: real PTY. Interactive Clack:
exact arrows/Enter; raw search typing can lie.

Isolate mutable state: `OPENCLAW_STATE_DIR=$(mktemp -d)`. Test-only local plugin
artifacts may use `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1`; never call them
official/trusted installs.

## Desktop / Cross-OS

Static hosts:

```sh
"$CRABBOX" run --provider ssh --target macos \
  --static-host mac-studio.local -- xcodebuild test
"$CRABBOX" run --provider ssh --target windows --windows-mode normal \
  --static-host win-dev.local -- pwsh -NoProfile -Command "dotnet test"
"$CRABBOX" run --provider ssh --target windows --windows-mode wsl2 \
  --static-host win-dev.local -- pnpm test
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

Human desktop: WebVNC preferred.

```sh
"$CRABBOX" warmup --provider hetzner --desktop --browser --keep
"$CRABBOX" desktop launch --provider hetzner --id <id> \
  --browser --url https://example.com --webvnc --open --take-control
"$CRABBOX" desktop doctor --provider hetzner --id <id>
"$CRABBOX" webvnc status --provider hetzner --id <id>
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

- Provider/CLI old: use sibling binary; update it.
- Config/auth: `config show`, `doctor`, `whoami`.
- Sync quiet/stale: `--debug --timing-json`, then `--full-resync` once.
- Testbox capacity: no retry storm. Use AWS only if equivalent proof.
- Command failure: read phase, failed test, JUnit, skipped shell segment. Focused
  rerun first.
- Cleanup unclear: list exact provider. Stop only owned ids.
- Wrapper broken, Blacksmith healthy: direct Blacksmith only to isolate wrapper.

Crabbox stop wrapper: no `--timing-json`.

## Boundary

Crabbox stays generic: lease, sync, command, logs, results, timing, cleanup.
OpenClaw setup belongs hydration workflow/repo scripts.
