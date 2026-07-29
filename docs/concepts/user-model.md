---
summary: "Store durable user preferences and profile facts as directive-based USER.md entries"
title: "User model"
read_when:
  - You want stable preferences to guide future sessions
  - You need to update a preference without leaving contradictory history
  - You are deciding whether something belongs in USER.md or MEMORY.md
---

`USER.md` is the optional user-model artifact in an agent workspace. It stores stable preferences, communication style, relationships, and active-project context as directives that can guide future sessions.

OpenClaw loads `USER.md` beside `MEMORY.md` at session start. It has a separate small bootstrap budget, and edits are picked up on later turns in a long-lived session. If the file is absent, startup continues without it.

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
