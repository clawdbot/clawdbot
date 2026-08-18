---
summary: "Manage durable user preferences and your Gateway profile identity"
title: "User model"
read_when:
  - You want stable preferences to guide future sessions
  - You need to update a preference without leaving contradictory history
  - You are deciding whether something belongs in USER.md or MEMORY.md
  - You want to link GitHub credit to your Gateway profile
---

`USER.md` is the optional user-model artifact in an agent workspace. It stores stable preferences, communication style, relationships, and active-project context as directives that can guide future sessions.

OpenClaw loads `USER.md` beside `MEMORY.md` at session start. It has a separate small bootstrap budget, and edits are picked up on later turns in a long-lived session. If the file is absent, startup continues without it.

## Gateway profile and GitHub credit

Your authenticated Gateway profile is separate from `USER.md`. Open **Settings → Profile → Identity** to set the display name and avatar shown to other people on the Gateway. A custom OpenClaw avatar remains authoritative even when you link GitHub.

Enter a GitHub username in the **GitHub** row to opt into public commit attribution. The Gateway resolves the public account through GitHub, stores its stable numeric account id and current login, and derives a GitHub noreply address. OpenClaw never requests or stores a private GitHub email for this feature.

When your authenticated profile has prompted a session before an agent run, commits created from that run receive your exact `Co-authored-by` trailer. All linked profile-backed human participants are eligible; channel-only identities, agents, bots, and the configured primary Git author are excluded. The participant set is bounded to 32 and recorded best-effort. The run tells the model when an eligible profile is unlinked or the bound may be incomplete; it never guesses an identity from transcript names.

OpenClaw supplies exact trailers in the model context for that turn and instructs coding agents to retain them through amendments, rebases, and squash commits so credit reaches the final commit merged to the default branch. The trailers are not exported through the process or shell environment. Git commands remain ordinary shell execution: OpenClaw does not replace `git` or install repository hooks, so the instruction and post-commit verification are the enforcement boundary.

Changing the linked username resolves and stores the new public account. **Disconnect** stops attribution for future runs; it does not rewrite commits that already contain the public trailer.

## Write directives, not observations

Each entry has a metadata line followed by one imperative directive:

```md
<!-- observed: 2026-07-27 | status: active -->

- Prefer concise progress updates during implementation work.
```

Use these rules:

- Begin with an imperative such as `Always`, `Never`, or `Prefer`.
- Record the date the preference was observed.
- Use only `active` or `superseded` for status.
- Keep one behavioral instruction per directive.
- Store only details that improve assistance. Do not turn the file into a dossier.

PrefEval found that preference following degrades sharply in longer conversations, even with retrieval and prompting ([arXiv:2502.09597](https://arxiv.org/abs/2502.09597)). Restating a stable preference as a directive makes the expected behavior explicit at the point where the agent uses it.

## Supersede in place

When a preference changes, update its existing section. Do not append a second active directive elsewhere in the file.

Before:

```md
<!-- observed: 2026-05-10 | status: active -->

- Prefer detailed explanations for every code change.
```

After:

```md
<!-- observed: 2026-05-10 | status: superseded -->

- Prefer detailed explanations for every code change.

<!-- observed: 2026-07-27 | status: active -->

- Prefer concise implementation summaries unless more detail is requested.
```

Keep the superseded entry next to its replacement so the current directive is unambiguous. HorizonBench reports that systems often select an originally stated preference after the user has changed it ([arXiv:2604.17283](https://arxiv.org/abs/2604.17283)); append-only contradictory history recreates that failure mode.

## Choose the right file

| Information                                                                      | Store it in                                    |
| -------------------------------------------------------------------------------- | ---------------------------------------------- |
| Stable preference or communication style                                         | `USER.md`                                      |
| Relationship or active-project fact that changes how the user should be assisted | `USER.md`                                      |
| Durable non-profile fact, decision, or lesson                                    | `MEMORY.md`                                    |
| Detailed observation or running context                                          | `memory/YYYY-MM-DD.md`                         |
| Event-conditioned future action                                                  | [Standing intents](/concepts/standing-intents) |
| Exact-time or recurring action                                                   | [Scheduled task](/automation/cron-jobs)        |

## Keep it compact

`USER.md` has a deliberately smaller bootstrap budget than general workspace files. When it becomes crowded, remove stale superseded entries and move project detail that does not alter behavior into daily memory or `MEMORY.md`.

## Related

- [Memory overview](/concepts/memory)
- [Standing intents](/concepts/standing-intents)
- [Agent workspace](/concepts/agent-workspace)
