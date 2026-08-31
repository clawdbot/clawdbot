---
name: openclaw-update
description: "Route routine updates of an existing local or remote OpenClaw Gateway to its installation owner, with automatic session recovery. Defer to deployment-specific skills when available."
---

# Update OpenClaw

Use for general requests to update an existing Claw/Gateway. Select the existing update workflow; do not create another deployer or scheduler. Release validation, publication, new installations, and unrelated hosts are outside this workflow.

## Resolve the owner

Identify the host, runtime user, profile/state root, service, running executable/release, and update owner from operator configuration and live inspection. The current repository or shell CLI may belong to another install. Keep private access details and state out of public artifacts.

Read the owner runbook and choose the matching workflow:

| Installation                               | Update path                                                                                                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical live main checkout and macOS app | [openclaw-live-updater](../openclaw-live-updater/SKILL.md).                                                                                                |
| Operator-configured Team server            | [update-team-server](../update-team-server/SKILL.md).                                                                                                      |
| Other managed deployments                  | Deployment-specific skill/runbook and existing owner, including containers and declarative installations.                                                  |
| Standard package or single-user source     | [Updating](../../../docs/install/updating.md) and the [update CLI contract](../../../docs/cli/update.md), using the owning CLI on the target host/profile. |

Follow the selected workflow's commands, locks, backup/migration requirements, recovery, and cleanup. Do not apply standard CLI updates inside a separately managed release or running container, mutate files used by a live Gateway, or overwrite dirty checkouts.

“Latest” preserves the configured channel; explicitly requested “latest main” selects the development source flow (`--channel dev` for the standard CLI). Preview the target and report the actual serving SHA: development preflight can select an older buildable commit. Do not auto-accept unapproved downgrades or plugin capability changes.

## Interruption and recovery

An update request includes routine restart and bounded interruption, subject to deployment policy. **Eligible sessions resume automatically. Do not ask again solely because agents, replies, or tasks are active.** Use the owner's graceful drain and recovery-preserving interruption.

Task cancellation, session aborts, and queue clearing can discard work; do not use them to manufacture idleness or manually replay recovered turns. PTYs do not survive. [Restart recovery](../../../docs/gateway/restart-recovery.md) owns recovery behavior and limits.

If the owner lacks controlled interruption, report or repair that gap within scope. Do not invent force flags, bypass persistence/compatibility gates, or repeat the interruption approval question.

## Verify

Use the owner's verification to prove the intended version/commit is serving, RPC/health and configured channels work, and UI/assets load through actual ingress when enabled. Inspect startup/recovery errors without exposing secrets. A build, handoff acknowledgement, or healthy old process is not completion. Report the serving version and remaining issues.
