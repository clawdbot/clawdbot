---
summary: "Kill-switch guardrail against runaway Anthropic spend on always-on gateways"
read_when:
  - Setting up or tuning a daily Anthropic spend cap for a deployed gateway
  - Investigating an unexpected Anthropic cost spike from an OpenClaw instance
  - A gateway was unexpectedly stopped and SPEND-PAUSED exists
title: "Spend Guardrail"
---

# Spend guardrail

Root cause (Cost Watch, 2026-07-14+): two always-on OpenClaw gateways ran
Opus-tier models on every unattended heartbeat, with no spend cap and no
kill switch. One key spent $347-$1,382/day for two weeks before anyone
noticed — driven by continuous cache-read volume from a stuck-ish context
re-read on (near-)every turn. `DEFAULT_MODEL` and `tools.loopDetection`
defaults now guard the _cause_; this script guards the _blast radius_ if
some other misconfiguration (a manual model override, a new agent, a
runaway subagent loop) produces the same pattern again.

## What it does

`scripts/spend-guardrail.sh` polls **actual billed spend** (not an
estimate) since UTC midnight via the Anthropic Admin API
(`/v1/organizations/usage_report/messages`), converts token usage to USD
using the same per-model pricing tiers as
`forge/src/lib/forge/claude-client.ts` (keep both in sync — see
`latest-llm-models.mdc`), and compares against `SPEND_CAP_USD`.

If the cap is exceeded, it does not just alert — it:

1. Writes `~/.openclaw/SPEND-PAUSED` (the kill-switch marker, same pattern
   as Forge's `.ralph-pause`).
2. Runs `launchctl bootout` on the gateway's launchd job — this **stops
   the gateway** and prevents `RunAtLoad` from restarting it on the next
   boot, so the runaway can't resume unattended.
3. Sends a Slack/ntfy alert with the exact resume command.

Subsequent runs no-op (log-only) while `SPEND-PAUSED` exists, so the
gateway stays down and the alert doesn't repeat every cron tick.

## Install (once per machine)

```bash
scp scripts/spend-guardrail.sh <host>:~/.openclaw/tools/spend-guardrail.sh
ssh <host> chmod +x ~/.openclaw/tools/spend-guardrail.sh
ssh <host> crontab -e
# add (every 30 min, matching the auth-watchdog cadence):
*/30 * * * * ANTHROPIC_ADMIN_KEY=sk-ant-admin-... SPEND_CAP_USD=100 ~/.openclaw/tools/spend-guardrail.sh >> /tmp/openclaw-spend-guardrail.log 2>&1
```

Get a read-only Admin API key at
`console.anthropic.com/settings/admin-keys` — "Usage & Cost" scope is
sufficient, no write access needed. Optionally scope the check to just
this machine's own key(s) via `ANTHROPIC_API_KEY_IDS` (comma-separated
`apikey_...` ids from the [List API Keys](https://platform.claude.com/docs/en/api/admin/apikeys/list)
endpoint) — otherwise it checks org-wide spend, which is only meaningful
if this gateway is the sole consumer of that Admin key's org.

## Resuming after a trip

```bash
rm ~/.openclaw/SPEND-PAUSED
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.gateway.plist
```

Investigate the cause first — check `openclaw infer model auth status`,
recent config changes, and the Admin API usage breakdown by model — before
resuming, or it will just trip again.

## Tuning `SPEND_CAP_USD`

Set it above your normal daily baseline with headroom for legitimate
bursts, but well below what you'd consider an incident. For reference, the
gateways described above ran a healthy baseline in the low tens of
dollars/day before the regression: check `usage_snapshots` in the
`noble-people-products` Supabase project (Everything hub's Cost Watch) for
this gateway's actual historical baseline before picking a number.
