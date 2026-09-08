---
summary: "Manage Gateway skills from the macOS app's Dashboard"
read_when:
  - Managing skills from the macOS app
  - Changing skills gating or install behavior
title: "Skills (macOS)"
---

Open **Dashboard → Skills** to inspect and manage skills for the connected
Gateway. The macOS app uses the same Control UI as a regular browser; there is
no separate native Skills pane. Select the intended Gateway before installing
or configuring a skill.

## Data source

- `skills.status` (gateway) returns all skills plus eligibility and missing requirements, including allowlist blocks for bundled skills.
- Requirements come from `metadata.openclaw.requires` in each `SKILL.md`.

## Install actions

- `metadata.openclaw.install` defines install options (brew/node/go/uv/download).
- The Dashboard calls `skills.install` to run installers on the Gateway host.
- To install for this Mac's local Gateway, connect to it first. Use **Connection… → Connection** to choose Local mode, or select its saved profile from **Gateways**.
- Operator-owned `security.installPolicy` (`enabled`, `targets`, `exec`) runs before installer metadata. `block` results and policy failures stop the install. A `warn` result also stops the gateway-backed request: review it with the matching direct CLI when one exists, or change the policy to allow the reviewed request, then retry.
- If every install option is `download`, the gateway surfaces all download choices.
- Otherwise the gateway picks one preferred installer using current install preferences (`skills.install.preferBrew`, `skills.install.nodeManager`) and host binaries: Homebrew first when `preferBrew` is enabled and `brew` is present, then `uv`, then the configured node manager, then Homebrew again if available (even without `preferBrew`), then `go`, then `download`.
- Node install labels reflect the configured node manager, including `yarn`.

## Browse ClawHub

Search ClawHub from **Dashboard → Skills** and open a result to inspect its
metadata, publisher, and release version before installing. The Gateway owns
the pre-download security check during installation.
Official ClawHub publishers and packages skip the security-verdict fetch, as
described in [ClawHub release trust](/cli/skills#release-trust).

A ClawHub **Review** audit outcome allows installation and returns audit text in
the result warning. **Blocked** or unavailable security checks stop installation. These
audit outcomes do not override the operator-owned install policy described above.

Install-only search results offer **Install** instead of a detail review. The Dashboard
sends their exact source reference without a version selector and labels unscanned
sources. After installation, it reads `skills.status` on the same Gateway route
to confirm the reviewed version or the recorded install-only reference.

## Env/API keys

- Skill configuration belongs to the Gateway under `skills.entries.<skillKey>` in its config, not to this Mac's device preferences.
- `skills.update` patches `enabled`, `apiKey`, and `env`.

## Remote mode

- Install and config updates happen on the gateway host, not the local Mac.
- When skill files, config, Mac-node connectivity, its catalog, or its executable
  inventory changes, the gateway emits `skills.changed` after invalidating its
  authoritative snapshot. Use **Refresh** on the Dashboard's Skills page to load
  the latest `skills.status` report.

## Related

- [Skills](/tools/skills)
- [macOS app](/platforms/macos)
