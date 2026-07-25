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
- Operator-owned `security.installPolicy` (`enabled`, `targets`, `exec`) can block gateway-backed skill installs before installer metadata runs. Built-in dangerous-code scanning (used for plugin installs) is not wired into the skill install flow.
- If every install option is `download`, the gateway surfaces all download choices.
- Otherwise the gateway picks one preferred installer using current install preferences (`skills.install.preferBrew`, `skills.install.nodeManager`) and host binaries: Homebrew first when `preferBrew` is enabled and `brew` is present, then `uv`, then the configured node manager, then Homebrew again if available (even without `preferBrew`), then `go`, then `download`.
- Node install labels reflect the configured node manager, including `yarn`.

## Env/API keys

- The app stores keys in `~/.openclaw/openclaw.json` under `skills.entries.<skillKey>`.
- `skills.update` patches `enabled`, `apiKey`, and `env`.

## Remote mode

- Install and config updates happen on the gateway host, not the local Mac.

## Related

- [Skills](/tools/skills)
- [macOS app](/platforms/macos)
