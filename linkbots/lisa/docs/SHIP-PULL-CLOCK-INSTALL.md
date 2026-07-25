# Lisa Option A — Ship/Pull Cron Install Notes

**Doctrine:** IDE Development `docs/AUTONOMOUS-GIT-OPERATIONS.md`  
**Procedure:** `linkbots/lisa/Personality files/agents/ship-pull-clock.md`  
**Do not commit secrets.** Live cron state lives on the Lisa gateway (Mini), not as secrets in git.

**User-facing wave names** use full clock times: Ship 06:00, Pull 08:00, Ship 16:00, Pull 18:00 (not A/B letters). Internal job ids may stay `lisa-ship-a` / `lisa-ship-b` etc.

## Human / ops prerequisites

1. **Mac Mini awake** with Keep Awake / Remote Control so Cursor ACP can spawn at 06:00 / 08:00 / 16:00 / 18:00 Asia/Taipei.
2. Lisa gateway healthy (`--profile lisa`); ACP/`acpx` working.
3. Personality mirror deployed or live workspace has `agents/ship-pull-clock.md`.

## Jobs to create (once)

| Name (internal) | Expr (Asia/Taipei) | User-facing wave |
| --------------- | ------------------ | ---------------- |
| `lisa-ship-a`   | `0 6 * * *`        | Ship 06:00       |
| `lisa-pull-a`   | `0 8 * * *`        | Pull 08:00       |
| `lisa-ship-b`   | `0 16 * * *`       | Ship 16:00       |
| `lisa-pull-b`   | `0 18 * * *`       | Pull 18:00       |

Match flags used by existing `lisa-morning-digest` / `lisa-heartbeat-45`: isolated session, `agentId: lisa-cron`, announce → Telegram `1123023078`.

**User-facing fields** (`description` + `payload.message`) must use clock times. Internal `--name` stays `lisa-ship-a` / `lisa-pull-a` / `lisa-ship-b` / `lisa-pull-b`. Edit live with:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron edit <id> \
  --description "Lisa Option A Ship 06:00: …" \
  --message "…"
```

#### Canonical message bodies (SOT — keep in sync with live)

Replace the wave label only: `Ship 06:00` / `Pull 08:00` / `Ship 16:00` / `Pull 18:00`. Shipper vs Puller prompt selection matches the wave.

```
Run <WAVE> (Asia/Taipei). Follow agents/ship-pull-clock.md strictly.

Runtime: isolated agentTurn as lisa-cron on Mac mini (sandbox off for host tools). Primary clock is Lisa Option A — spawn Cursor ACP; do not substitute a Lisa subagent or self-write code.

1) read agents/ship-pull-clock.md
2) sessions_spawn runtime=acp agentId=cursor model=grok-4.5[effort=high,fast=true] with the Shipper|Puller ACP prompt from that file (WAVE=<WAVE>)
3) Wait for ACP completion (sessions_yield). On spawn failure: quote error; write <WAVE>: Issues; stop.
4) Ensure /Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md has exactly one line: <WAVE>: Clear OR <WAVE>: Issues (no lists/links).
5) Final Telegram reply = that same one line only.

HARD RULE: NEVER call cron.add / cron.update / cron.remove from this isolated job. Mini must be awake for ACP.
```

Descriptions:

| Job id        | Description prefix                                |
| ------------- | ------------------------------------------------- |
| `lisa-ship-a` | `Lisa Option A Ship 06:00: Cursor ACP Shipper; …` |
| `lisa-pull-a` | `Lisa Option A Pull 08:00: Cursor ACP Puller; …`  |
| `lisa-ship-b` | `Lisa Option A Ship 16:00: Cursor ACP Shipper; …` |
| `lisa-pull-b` | `Lisa Option A Pull 18:00: Cursor ACP Puller; …`  |

### Tool allowlist (required — 2026-07-25 fix)

Ship/Pull jobs already set `payload.toolsAllow` including `sessions_spawn`. That is **not enough** alone: OpenClaw intersects cron `toolsAllow` with `agents.list[lisa-cron].tools.allow`. If `sessions_spawn` is missing from the agent allowlist, the live cron run will not expose the tool (Ship 16:00 2026-07-25 failed this way even though the job JSON listed it).

1. **Agent config** (`~/.openclaw-lisa/openclaw.json` → `agents.list` id `lisa-cron` → `tools.allow`) must include at least:
   - `sessions_spawn` (Cursor ACP spawn)
   - `sessions_yield` (wait for ACP completion announce)
   - plus the usual host ops tools (`read` / `write` / `edit` / `exec` / `process` / `cron` / session list helpers)
2. **Each Ship/Pull job** `payload.toolsAllow` must also include `sessions_spawn` and `sessions_yield` (digest/heartbeat jobs should **omit** these so they stay non-spawning).
3. Do **not** change `main` agent tools for this fix.

Repo SOT mirror: `linkbots/lisa/Personality files/openclaw.json`.

## Verify

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron list
```

Confirm all four jobs are present and enabled. Do not disable digest/heartbeat jobs while installing.

Policy check (no Telegram): confirm live `lisa-cron.tools.allow` contains `sessions_spawn`, and each Ship/Pull job’s `toolsAllow` does too (`cron list --json`). Prefer a one-word tool-inventory agent turn over force-running Ship/Pull (force-run announces Clear/Issues to Telegram).

## Backup

If Lisa ACP is down, optional Cursor Automations remain documented in IDE Development `docs/CURSOR-AUTOMATIONS-SETUP.md` (backup only — not primary).
