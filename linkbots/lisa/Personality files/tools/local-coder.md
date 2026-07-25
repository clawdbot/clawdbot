# Local Coder Route (mandatory)

Dedicated OpenClaw agent for **local-model coding**. Use this instead of Cursor ACP, instead of Lisa writing code on DeepSeek, and instead of shell `ollama run`.

## When to use

Carlos says any of: "local model", "local coder", "use coder", "use qwen", "use q9 for coding", "don't use Cursor", or names `ollama/qwen3.5:9b` / `q9` for a coding task.

## Required spawn

```json
{
  "runtime": "subagent",
  "agentId": "local-coder",
  "model": "ollama/qwen3.5:9b",
  "context": "isolated",
  "mode": "run",
  "lightContext": true,
  "runTimeoutSeconds": 1200,
  "task": "<full self-contained coding brief: absolute scratch paths, acceptance checks, run commands>"
}
```

Then call `sessions_yield` and wait for the **child completion announce** (definitive terminal event). Do **not** poll. Do **not** treat a premature requester-settle wake with `status: unknown` / `(no output)` as final if the child is still running — wait for the real child terminal announce or a truthful timeout/cancel. Keep the parent turn alive until the child finishes — do not abandon early (Control UI "Connect timeout" is usually parent-turn impatience / denied-shell thrash, not ollama death).

## Hard rules

1. **Must** spawn `agentId: "local-coder"` (native subagent). Verify `resolvedModel` / `modelApplied` in the tool result.
2. **Must not** use `runtime: "acp"` / Cursor for this route.
3. **Must not** write/edit the code yourself on DeepSeek / main session.
4. **Must not** fall back to `exec` / `ollama run` / pipes / redirects. If spawn or the child fails, report the verbatim error and stop.
5. **Must not** copy/persist the child's code onto the host path yourself. If the host-visible artifact is missing after a terminal child result, **report failure** — do not improvise a parent `write`.
6. On completion announce: verify the host-visible file under the allowed scratch directory + run output. Exactly one final answer — no `status: unknown` followed by a contradictory success.
7. Task text must be self-contained: absolute paths under `/Users/linktrend/.openclaw-lisa/workspace/scratch/...`, exact acceptance criteria, required run commands. The child has no parent chat history.

## Parent post-completion tripwire checklist (mandatory)

Before any success claim to Carlos (Control UI, Telegram, or "done"), walk this list **in order**. Skipping a step when it applies is a rule violation (Test-2 class failure).

| #   | Gate                             | Required action                                                                                                                                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Child terminal announce received | Wait for real completion; do not treat early settle / `(no output)` as success                                                                                                                                                              |
| 2   | Host artifact verified           | Confirm file exists under shared scratch + run/check succeeded when requested                                                                                                                                                               |
| 3   | Email requested?                 | If **yes** → continue to gate 4. If **no** → skip to gate 6                                                                                                                                                                                 |
| 4   | Draft email body                 | `write` English body to `scratch/<name>.txt` (never Chinese)                                                                                                                                                                                |
| 5   | Send via safe wrapper            | Run `tools/bin/lisa-safe email-send --to <…@linktrend.media> --subject "…" --body-file scratch/<name>.txt` and confirm **exit 0 / success in tool result**. Never bare `gws gmail +send` first. Never claim email sent without this success |
| 6   | One English final confirmation   | Only after gates 1–2 (and 4–5 when email was requested). English only                                                                                                                                                                       |

**Forbidden success patterns (never do these):**

- Report "local-coder succeeded" / "Test passed" / "email sent" while gate 5 is still unmet when email was requested
- Emit Chinese refusal templates after a successful verify (e.g. `你好，我无法给到相关内容。`) — ban absolute; if email/tool fails mid-delivery, say in English what succeeded and what failed
- Treat child report alone as email delivery — **child never sends email**; parent owns `lisa-safe email-send`

**English-only to Carlos:** parent final confirmation, Telegram, and email body must be English.

## Artifact paths (shared scratch)

- Host-visible scratch (canonical): `/Users/linktrend/.openclaw-lisa/workspace/scratch/`
- Local-coder workspace scratch is mapped to that same host tree (symlink). Relative `scratch/...` writes from the child land on the host path.
- Prefer absolute paths under the host scratch directory in the task brief.
- Paths outside that scratch directory are rejected by the local-coder artifact contract.

## Chosen model (2026-07-22)

- **Primary local coder:** `ollama/qwen3.5:9b` (installed; verified with `ollama list`)
- **Routing:** local-coder is automatic for coding from 19:00–04:00 Asia/Taipei and whenever Carlos explicitly asks for local-coder/Qwen local coding.
- **Overflow fix:** spawning onto `local-coder` uses a tiny workspace bootstrap; ollama overrides on `main` auto-enable `lightContext` so Lisa's 40k+ AGENTS/TOOLS dump is not injected.

## Failure behavior

If `sessions_spawn` errors, context-overflows, times out, or the child reports failure / missing host artifact: quote the error, do not silently redo the work, do not shell out to Ollama, do not parent-write the file. If email was requested and `lisa-safe email-send` fails: quote the error in English, state that coding verified but email was **not** sent, and stop — do not claim overall success.
