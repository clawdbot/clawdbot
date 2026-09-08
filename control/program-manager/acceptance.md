# Program Manager acceptance

| Check                 | Required proof                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| One canonical context | `CONTRACT.md` is the only semantic contract; `TOOLS.md` contains only minimal mechanics.                                           |
| Small prompt          | Source check passes the per-file and total bootstrap budgets.                                                                      |
| Truthful state        | Current `get_goal`/task-packet state is owner SQLite/session state; the checked-in fixture is not installed.                       |
| Safe boundary         | The reviewed config exposes only read, planning, and bounded worker handoff tools.                                                 |
| Active config         | PM-only config sync is backed up, reversible, supports both registry shapes, and passes active-binary validation.                  |
| Compact output        | PLAN, STATUS, HANDOFF, and COMPLETION profiles are present; the old field list is absent.                                          |
| Local model boundary  | Qwen chat-template thinking is explicitly disabled so local PM turns do not spend the bounded response budget on hidden reasoning. |
| Reversible staging    | Install/verify-install/rollback change only managed files and preserve unrelated files.                                            |
| Repeatable CI         | Static checks run without private operator state or live credentials.                                                              |
| Local behavior        | Run a local PM smoke with representative plan, status, handoff, and unsupported-completion prompts.                                |

The package is not complete until source checks, focused tests, workflow sanity,
config validation, and the local smoke all pass. A successful static check is
not behavioral proof; owner acceptance is still required for final certification.
