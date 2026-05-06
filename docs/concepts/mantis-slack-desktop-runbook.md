---
summary: "Operator runbook for Mantis Slack desktop QA: GitHub dispatch, local CLI, warm VNC leases, hydrate modes, timing interpretation, artifacts, and failure handling."
read_when:
  - Running Mantis Slack desktop QA from GitHub or locally
  - Debugging slow Mantis Slack desktop runs
  - Choosing source, prehydrated, or warm-lease mode
  - Posting screenshot and video evidence to a PR
title: "Mantis Slack desktop runbook"
---

Mantis Slack desktop QA is the real-UI lane for Slack-class bugs that need a
Linux desktop, VNC rescue, Slack Web, a real OpenClaw gateway, screenshots,
videos, and a PR evidence comment.

Use it when unit tests or the headless Slack live lane cannot prove the bug.

## Storage model

Mantis uses three different storage layers:

- Provider image: owned by Crabbox and stored in the cloud provider account.
  It contains machine capabilities such as Chrome/Chromium, ffmpeg, scrot,
  Node/corepack/pnpm, native build tools, and empty cache directories.
- Warm lease state: owned by the current operator session. It can contain a
  logged-in browser profile, `/var/cache/crabbox/pnpm`, and a prepared source
  checkout while the lease is alive.
- Mantis artifacts: owned by the OpenClaw run. They live under
  `.artifacts/qa-e2e/mantis/...`, then GitHub Actions uploads them and the
  Mantis GitHub App comments inline evidence on the PR.

Never put secrets, browser cookies, Slack login state, repository checkouts,
`node_modules`, or `dist/` into a prebaked provider image.

## GitHub dispatch

Run the workflow from `main`:

```bash
gh workflow run mantis-slack-desktop-smoke.yml \
  --ref main \
  -f candidate_ref=<trusted-ref-or-sha> \
  -f pr_number=<pr-number> \
  -f scenario_id=slack-canary \
  -f crabbox_provider=aws \
  -f keep_vm=false \
  -f hydrate_mode=source
```

Allowed `candidate_ref` values are intentionally narrow because the workflow
uses live credentials: current `main` ancestry, release tags, or an open PR head
from `openclaw/openclaw`.

The workflow writes:

- uploaded artifact: `mantis-slack-desktop-smoke-<run-id>-<attempt>`;
- inline PR comment from the Mantis GitHub App;
- `slack-desktop-smoke.png`;
- `slack-desktop-smoke.mp4`;
- `slack-desktop-smoke-preview.gif`;
- `slack-desktop-smoke-change.mp4`;
- `mantis-slack-desktop-smoke-summary.json`;
- `mantis-slack-desktop-smoke-report.md`;
- remote logs such as `slack-desktop-command.log`, `openclaw-gateway.log`,
  `chrome.log`, and `ffmpeg.log`.

The PR comment is updated in place by the hidden
`<!-- mantis-slack-desktop-smoke -->` marker.

## Local CLI

Cold source proof:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --provider aws \
  --class standard \
  --gateway-setup \
  --credential-source convex \
  --credential-role maintainer \
  --provider-mode live-frontier \
  --model openai/gpt-5.4 \
  --alt-model openai/gpt-5.4 \
  --scenario slack-canary \
  --hydrate-mode source
```

Keep the VM for VNC rescue:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --provider aws \
  --class standard \
  --gateway-setup \
  --scenario slack-canary \
  --keep-lease
```

Open VNC:

```bash
crabbox vnc --provider aws --id <cbx_id> --open
```

Reuse a warm lease:

```bash
pnpm openclaw qa mantis slack-desktop-smoke \
  --provider aws \
  --lease-id <cbx_id-or-slug> \
  --gateway-setup \
  --scenario slack-canary \
  --hydrate-mode source
```

Use `--hydrate-mode prehydrated` only when the reused remote workspace already
has `node_modules` and a built `dist/`. Mantis fails closed if those are
missing.

## Hydrate modes

| Mode          | Use when                                  | Remote behavior                                                                       | Tradeoff                                                 |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `source`      | Normal PR proof, cold machines, CI        | Runs `pnpm install --frozen-lockfile --prefer-offline` and `pnpm build` inside the VM | Slowest, strongest source-checkout proof                 |
| `prehydrated` | You intentionally prepared a reused lease | Requires existing `node_modules` and `dist/`; skips install/build                     | Fast, but only valid for operator-controlled warm leases |

GitHub Actions always prepares the candidate checkout before the VM run. Its
pnpm store is cached by OS, Node version, and lockfile. The VM source run also
uses `/var/cache/crabbox/pnpm` when present.

## Timing interpretation

`mantis-slack-desktop-smoke-report.md` includes phase timings:

- `crabbox.warmup`: cloud provider boot, desktop/browser readiness, and SSH.
- `crabbox.inspect`: lease metadata lookup.
- `credentials.prepare`: Convex credential lease acquisition.
- `crabbox.remote_run`: sync, browser launch, OpenClaw install/build or
  hydrate validation, gateway startup, screenshot, and video capture.
- `artifacts.copy`: rsync back from the VM.

`crabbox.remote_run` can be marked `accepted` when Crabbox returns a non-zero
remote status after Mantis has copied metadata proving that the OpenClaw gateway
is alive and the setup completed. Treat `accepted` as pass-with-explanation,
not a failed scenario.

If the run is slow:

- warmup dominates: prebake or promote a better Crabbox provider image;
- remote_run dominates in `source`: use a warm lease, improve pnpm store reuse,
  or move machine prerequisites into the provider image;
- remote_run dominates in `prehydrated`: the remote workspace was not actually
  ready, or the gateway/browser/Slack setup is slow;
- artifact copy dominates: inspect video size and artifact directory contents.

## Evidence checklist

A good PR comment should show:

- scenario id and candidate SHA;
- GitHub Actions run URL;
- artifact URL;
- inline screenshot;
- inline animated preview when available;
- full MP4 and trimmed MP4 links;
- pass/fail status;
- timing summary in the attached report.

Do not commit screenshots or videos into the repository. Keep them in GitHub
Actions artifacts or the PR comment.

## Failure handling

If the workflow fails before the VM run, inspect the Actions job first. Typical
causes are untrusted `candidate_ref`, missing environment secrets, or candidate
install/build failure.

If the VM run fails but screenshots were copied back, inspect:

```bash
cat mantis-slack-desktop-smoke-report.md
cat mantis-slack-desktop-smoke-summary.json
cat slack-desktop-command.log
cat openclaw-gateway.log
cat chrome.log
cat ffmpeg.log
```

If the run kept the lease, open VNC with the report's `crabbox vnc ...` command.
Stop the lease when done:

```bash
crabbox stop --provider aws <cbx_id-or-slug>
```

If Slack login expired, repair it in VNC on a kept lease and rerun with
`--lease-id`. Do not bake that browser profile into a provider image.

## Related

- [QA overview](/concepts/qa-e2e-automation)
- [Slack channel](/channels/slack)
- [Testing](/help/testing)
