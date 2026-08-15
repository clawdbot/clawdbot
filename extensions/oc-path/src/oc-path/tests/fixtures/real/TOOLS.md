## Tool Guidance

| tool | guidance                                                      |
| ---- | ------------------------------------------------------------- |
| gh   | Use for GitHub operations (issues, PRs, CI). Prefer over web. |
| curl | HTTP client. Use --silent for clean output.                   |
| rg   | ripgrep — content search. Faster than grep for code.          |
| fd   | find replacement. Use over `find` when available.             |

## Allow / Deny

- enabled: gh
- enabled: curl
- enabled: rg
- enabled: fd
- disabled: legacy-tool

## Notes

The agent reads this file at session start; runtime tool gates honor
the `enabled` flags.
