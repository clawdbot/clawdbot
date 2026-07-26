# Lisa Option A — Ship/Pull Cron Install Notes

**Doctrine:** IDE Development `docs/AUTONOMOUS-GIT-OPERATIONS.md`  
**Procedure:** `linkbots/lisa/Personality files/agents/ship-pull-clock.md`  
**Do not commit secrets.** Live cron state lives on the Lisa gateway (Mini), not as secrets in git.

**Wave names** use local hour labels: Ship 05, Pull 07, Ship 16, Pull 18 (not A/B letters; not `Ship 05:00`).

## Human / ops prerequisites

1. **Mac Mini awake** with Keep Awake / Remote Control so Cursor ACP can spawn at 05:00 / 07:00 / 16:00 / 18:00 Asia/Taipei.
2. Lisa gateway healthy (`--profile lisa`); ACP/`acpx` working.
3. Personality mirror deployed or live workspace has `agents/ship-pull-clock.md`.

## Related schedule (digest / heartbeat)

| Name                  | Expr (Asia/Taipei)                      | Notes                                                              |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `lisa-heartbeat-45`   | `45 0,2,4,6,10,12,14,16,18,20,22 * * *` | Includes 06:45; **no 08:45**                                       |
| `lisa-morning-digest` | `30 8 * * *`                            | Email A+B+D (+ Main Approve when needed); Telegram A–D (+ Approve) |

## Jobs to create (once)

| Name           | Expr (Asia/Taipei) | Wave    |
| -------------- | ------------------ | ------- |
| `lisa-ship-05` | `0 5 * * *`        | Ship 05 |
| `lisa-pull-07` | `0 7 * * *`        | Pull 07 |
| `lisa-ship-16` | `0 16 * * *`       | Ship 16 |
| `lisa-pull-18` | `0 18 * * *`       | Pull 18 |

Match flags used by existing `lisa-morning-digest` / `lisa-heartbeat-45`: isolated session, `agentId: lisa-cron`, announce → Telegram `1123023078`. Message body should instruct: read and run `agents/ship-pull-clock.md` for that wave (spawn Cursor ACP with the shipper or puller prompt; Telegram + email one-liner after completion).

**Email exec HARD (2026-07-26):** cron messages must say `tools/bin/lisa-safe` is a **script file** — never list/explore it; invoke `email-send` once, unpiped. Pull 07 failed when the agent ran `list files in …/lisa-safe` via `exec`.

### Tool allowlist (required — 2026-07-25 fix)

Ship/Pull jobs already set `payload.toolsAllow` including `sessions_spawn`. That is **not enough** alone: OpenClaw intersects cron `toolsAllow` with `agents.list[lisa-cron].tools.allow`. If `sessions_spawn` is missing from the agent allowlist, the live cron run will not expose the tool (Ship 16 2026-07-25 failed this way even though the job JSON listed it).

1. **Agent config** (`~/.openclaw-lisa/openclaw.json` → `agents.list` id `lisa-cron` → `tools.allow`) must include at least:
   - `sessions_spawn` (Cursor ACP spawn)
   - `sessions_yield` (wait for ACP completion announce)
   - plus the usual host ops tools (`read` / `write` / `edit` / `exec` / `process` / `cron` / session list helpers) so `lisa-safe email-send` works after each wave
2. **Each Ship/Pull job** `payload.toolsAllow` must also include `sessions_spawn` and `sessions_yield` (digest/heartbeat jobs should **omit** these so they stay non-spawning).
3. Do **not** change `main` agent tools for this fix.

Repo SOT mirror: `linkbots/lisa/Personality files/openclaw.json`.

## Verify

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron list
```

Confirm all four jobs are present and enabled (`lisa-ship-05`, `lisa-pull-07`, `lisa-ship-16`, `lisa-pull-18`). Do not disable digest/heartbeat jobs while installing.

Policy check (no Telegram): confirm live `lisa-cron.tools.allow` contains `sessions_spawn`, and each Ship/Pull job’s `toolsAllow` does too (`cron list --json`). Prefer a one-word tool-inventory agent turn over force-running Ship/Pull (force-run announces Clear/Issues to Telegram).

## Backup

If Lisa ACP is down, optional Cursor Automations remain documented in IDE Development `docs/CURSOR-AUTOMATIONS-SETUP.md` (backup only — not primary).
