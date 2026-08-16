---
summary: "macOS Skills settings UI and gateway-backed status"
read_when:
  - Updating the macOS Skills settings UI
  - Changing skills gating or install behavior
title: "Skills (macOS)"
---

The macOS app surfaces OpenClaw skills via the gateway; it does not parse skills locally.

## Data source

- `skills.status` (gateway) returns all skills plus eligibility and missing requirements, including allowlist blocks for bundled skills.
- Requirements come from `metadata.openclaw.requires` in each `SKILL.md`.

## Install actions

- `metadata.openclaw.install` defines install options (brew/node/go/uv/download).
- The app calls `skills.install` to run installers on the gateway host.
- Operator-owned `security.installPolicy` (`enabled`, `targets`, `exec`) runs before installer metadata. `block` results and policy failures stop the install. A `warn` result also stops the gateway-backed request: review it with the matching direct CLI when one exists, or change the policy to allow the reviewed request, then retry.
- If every install option is `download`, the gateway surfaces all download choices.
- Otherwise the gateway picks one preferred installer using current install preferences (`skills.install.preferBrew`, `skills.install.nodeManager`) and host binaries: Homebrew first when `preferBrew` is enabled and `brew` is present, then `uv`, then the configured node manager, then Homebrew again if available (even without `preferBrew`), then `go`, then `download`.
- Node install labels reflect the configured node manager, including `yarn`.

## Env/API keys

- The app stores keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` patches `enabled`, `apiKey`, and `env`.

## Remote mode

- Install and config updates happen on the gateway host, not the local Mac.
- When skill files, config, Mac-node connectivity, its catalog, or its executable
  inventory changes, the gateway emits `skills.changed` after invalidating its
  authoritative snapshot. An open Skills pane then refetches `skills.status`,
  including changes that finish while an earlier request is still in flight.

## Related

- [Skills](/tools/skills)
- [macOS app](/platforms/macos)
