---
summary: "CLI reference for `openclaw ready` (canonical Gateway readiness)"
read_when:
  - You need a scriptable readiness check for a running Gateway
title: "Ready"
---

# `openclaw ready`

Fetch the canonical readiness result from the running Gateway. This is the CLI projection of the same condition set used by Gateway `/ready`, `/readyz`, health, and status surfaces; it does not run a separate local evaluator.

## Options

| Flag             | Default | Description                                   |
| ---------------- | ------- | --------------------------------------------- |
| `--json`         | `false` | Print the canonical readiness result as JSON. |
| `--timeout <ms>` | `10000` | Gateway connection timeout in milliseconds.   |

```bash
openclaw ready
openclaw ready --json
openclaw ready --timeout 2500
```

Human output identifies the producer, summarizes required/advisory counts, then
lists every condition with its subject, status, requirement, stable reason, and
diagnostic message. `--json` returns the complete canonical result unchanged,
including `contractVersion`, `evaluatedAtMs`, the reconciled `identity.subjects` package, condition
subject references, `failures`, and `advisories`.

Repeated JSON results can be compared by `(subjectRef, type)`. Subject `id`
tracks the lifetime owned by that subject: host workload, process, Gateway
serving lifecycle, plugin resource, or node. `generation` tracks an
owner-defined revision of the same subject, such as active config or pairing
state. A Gateway keeps one ID across readiness evaluations, reload, and drain,
and receives a new ID when its serving lifecycle restarts.

When the Gateway cannot be reached or does not expose the readiness contract, `--json` returns `ready: false` with a structured `error.reason` and `error.message` instead of emitting a partial condition set.

## Exit codes

| Code | Meaning                                                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | The Gateway reported ready. Advisory findings may still be present.                                                                    |
| `1`  | A required condition failed or was unknown, the Gateway was unavailable, or the running Gateway did not expose the readiness contract. |

## Related

- [`openclaw health`](/cli/health)
- [`openclaw status`](/cli/status)
- [Gateway health and readiness](/gateway/health)
