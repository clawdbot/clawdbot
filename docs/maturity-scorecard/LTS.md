---
title: LTS category proposal
version: 1
---

# LTS category proposal

This proposal identifies a minimal set of maturity-scorecard categories that
should be eligible for the first enterprise-oriented LTS support promise.

Scores are shown as `Coverage/Quality` from the current
`inventory/<surface>/scores.yaml` files. They are useful context, but LTS
eligibility here is a human product-support decision and does not require the
current mechanical threshold of `coverage > 90` and `quality > 80`.
Coverage and Quality numbers are Codex-generated and still need human
verification before they are treated as authoritative.
Completeness is intentionally omitted until that score is ready for use.
Category names link to the corresponding per-category evidence note.

Legend:

- `Surface`: a top-level product or operating area in the taxonomy, such as `Gateway runtime`, `CLI`, `Slack`, or `Linux Gateway host`.
- `Category`: a scored capability area within one surface, used as the unit for maturity and LTS inclusion decisions.
- `✅`: category is included in the proposed initial LTS slice.
- `➡️`: category is deferred from the proposed initial LTS slice.

## Proposed initial LTS Surfaces

### Gateway runtime (12/13)

| Status | Category                                                                                              | Score (Coverage/Quality) |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Gateway Lifecycle](inventory/gateway-runtime/runtime-lifecycle-and-supervision.md)                   | `86/82`                  |
| ✅     | [WebSocket Connection](inventory/gateway-runtime/websocket-handshake-and-session-establishment.md)    | `84/76`                  |
| ✅     | [Device Auth and Pairing](inventory/gateway-runtime/device-identity-auth-and-pairing.md)              | `88/72`                  |
| ✅     | [Security Controls](inventory/gateway-runtime/security-and-hardening-posture.md)                      | `84/74`                  |
| ✅     | [Approvals and Remote Execution](inventory/gateway-runtime/approval-and-execution-safety.md)          | `88/72`                  |
| ✅     | [Roles and Permissions](inventory/gateway-runtime/roles-scopes-and-operator-policy.md)                | `85/62`                  |
| ✅     | [Health, Diagnostics, and Repair](inventory/gateway-runtime/observability-health-and-repair.md)       | `68/62`                  |
| ✅     | [HTTP APIs](inventory/gateway-runtime/http-apis.md)                                                   | `88/74`                  |
| ✅     | [Hosted Web Surface](inventory/gateway-runtime/hosted-web-surface.md)                                 | `88/74`                  |
| ✅     | [Gateway RPC APIs and Events](inventory/gateway-runtime/core-rpc-coverage.md)                         | `68/57`                  |
| ✅     | [Network Access and Discovery](inventory/gateway-runtime/network-exposure-and-transport-selection.md) | `68/62`                  |
| ➡️     | [Nodes and Remote Capabilities](inventory/gateway-runtime/node-transport-and-capability-relay.md)     | `84/63`                  |
| ✅     | [Protocol Compatibility](inventory/gateway-runtime/protocol-typing-and-compatibility.md)              | `72/70`                  |

### Security, auth, pairing, and secrets (5/6)

| Status | Category                                                                                                                            | Score (Coverage/Quality) |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Approval Policy and Tool Safeguards](inventory/security-auth-pairing-and-secrets/approval-policy-and-dangerous-tool-safeguards.md) | `86/72`                  |
| ✅     | [Gateway Auth and Remote Access](inventory/security-auth-pairing-and-secrets/gateway-auth-and-network-exposure.md)                  | `82/68`                  |
| ✅     | [Device and Node Pairing](inventory/security-auth-pairing-and-secrets/device-identity-and-operator-pairing.md)                      | `83/66`                  |
| ✅     | [Credential and Secret Hygiene](inventory/security-auth-pairing-and-secrets/secrets-storage-redaction-and-configuration-hygiene.md) | `78/62`                  |
| ✅     | [Channel Access Control](inventory/security-auth-pairing-and-secrets/channel-identity-allowlists-and-sender-pairing.md)             | `78/66`                  |
| ➡️     | [Plugin Trust](inventory/security-auth-pairing-and-secrets/plugin-installation-trust-and-security-boundaries.md)                    | `76/70`                  |

### Agent Runtime (6/9)

| Status | Category                                                                                                                             | Score (Coverage/Quality) |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| ✅     | [Agent Turn Execution](inventory/agent-runtime-and-provider-execution/agent-turn-orchestration-and-runtime-lifecycle.md)             | `82/74`                  |
| ✅     | [Model and Runtime Selection](inventory/agent-runtime-and-provider-execution/model-selection-provider-routing-and-runtime-policy.md) | `84/72`                  |
| ✅     | [Hosted Provider Execution](inventory/agent-runtime-and-provider-execution/hosted-provider-adapters-and-payload-compatibility.md)    | `76/70`                  |
| ✅     | [Tool Execution Controls](inventory/agent-runtime-and-provider-execution/tool-execution-approvals-and-sandbox-policy.md)             | `86/74`                  |
| ✅     | [Provider Auth](inventory/agent-runtime-and-provider-execution/provider-auth-profiles-and-credential-health.md)                      | `80/66`                  |
| ➡️     | [External Runtimes and Subagents](inventory/agent-runtime-and-provider-execution/cli-harnesses-external-runtimes-and-subagents.md)   | `78/66`                  |
| ➡️     | [Local and Self-hosted Providers](inventory/agent-runtime-and-provider-execution/local-and-self-hosted-provider-execution.md)        | `70/60`                  |
| ➡️     | [Streaming and Progress](inventory/agent-runtime-and-provider-execution/streaming-progress-and-preview-visibility.md)                | `84/70`                  |
| ✅     | [Tool Calls and Response Handling](inventory/agent-runtime-and-provider-execution/streaming-tool-call-and-response-normalization.md) | `80/66`                  |

### Session, memory, and context engine (6/9)

| Status | Category                                                                                                                          | Score (Coverage/Quality) |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Session Routing](inventory/session-memory-and-context-engine/session-routing-and-conversation-binding.md)                        | `82/74`                  |
| ✅     | [CLI Session and Transcript Management](inventory/session-memory-and-context-engine/cli-session-and-transcript-management.md)     | `74/68`                  |
| ✅     | [Context Engine](inventory/session-memory-and-context-engine/context-engine-and-runtime-assembly.md)                              | `72/80`                  |
| ✅     | [Transcript Persistence](inventory/session-memory-and-context-engine/transcript-persistence-and-durability.md)                    | `78/58`                  |
| ✅     | [Token Management](inventory/session-memory-and-context-engine/compaction-pruning-and-token-pressure.md)                          | `78/60`                  |
| ➡️     | [Cross-client History and Session Parity](inventory/session-memory-and-context-engine/cross-client-history-and-session-parity.md) | `76/62`                  |
| ➡️     | [Diagnostics, Maintenance, and Recovery](inventory/session-memory-and-context-engine/diagnostics-maintenance-and-recovery.md)     | `72/68`                  |
| ✅     | [Core Prompts and Context](inventory/session-memory-and-context-engine/instruction-profile-and-context-visibility.md)             | `68/70`                  |
| ➡️     | [Memory](inventory/session-memory-and-context-engine/memory-files-tools-and-active-memory.md)                                     | `66/58`                  |

### CLI (6/7)

| Status | Category                                                                                                              | Score (Coverage/Quality) |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [CLI Setup](inventory/cli-install-update-onboard-doctor/package-install-and-cli-entrypoints.md)                       | `78/75`                  |
| ✅     | [Onboarding and Auth Setup](inventory/cli-install-update-onboard-doctor/first-run-onboarding-and-auth-selection.md)   | `86/78`                  |
| ✅     | [Gateway Service Management](inventory/cli-install-update-onboard-doctor/gateway-service-install-and-lifecycle.md)    | `88/66`                  |
| ✅     | [CLI Observability](inventory/cli-install-update-onboard-doctor/status-health-logs-and-diagnostics-support-path.md)   | `84/74`                  |
| ✅     | [Doctor](inventory/cli-install-update-onboard-doctor/doctor-config-auth-plugin-and-lint.md)                           | `80/68`                  |
| ✅     | [Updates and Upgrades](inventory/cli-install-update-onboard-doctor/update-channel-and-core-upgrade-flow.md)           | `82/68`                  |
| ➡️     | [Plugin and Channel Setup](inventory/cli-install-update-onboard-doctor/plugin-and-channel-setup-during-onboarding.md) | `82/72`                  |

### Linux Gateway host (4/5)

| Status | Category                                                                                                              | Score (Coverage/Quality) |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Host Setup and Updates](inventory/linux-gateway-host/linux-cli-install-and-update-path.md)                           | `82/78`                  |
| ✅     | [Gateway Runtime and Service Control](inventory/linux-gateway-host/foreground-gateway-runtime-and-process-control.md) | `83/78`                  |
| ✅     | [Remote Access and Security](inventory/linux-gateway-host/remote-network-exposure-tls-and-tailscale.md)               | `78/74`                  |
| ✅     | [Diagnostics and Repair](inventory/linux-gateway-host/diagnostics-logs-doctor-and-repair.md)                          | `82/78`                  |
| ➡️     | [Deployment Targets](inventory/linux-gateway-host/vps-container-and-cloud-deployment-guidance.md)                     | `76/72`                  |

### Windows via WSL2 (5/6)

| Status | Category                                                                                          | Score (Coverage/Quality) |
| ------ | ------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [WSL Setup](inventory/windows-via-wsl2/wsl2-install-and-runtime-prerequisites.md)                 | `76/70`                  |
| ✅     | [CLI](inventory/windows-via-wsl2/wsl2-cli.md)                                                     | `76/70`                  |
| ✅     | [Gateway Service Lifecycle](inventory/windows-via-wsl2/systemd-gateway-service-lifecycle.md)      | `64/66`                  |
| ✅     | [Gateway Access and Exposure](inventory/windows-via-wsl2/auth-secrets-and-exposure-posture.md)    | `70/65`                  |
| ✅     | [Diagnostics and Repair](inventory/windows-via-wsl2/diagnostics-doctor-logs-and-repair.md)        | `74/72`                  |
| ➡️     | [Browser and Control UI](inventory/windows-via-wsl2/split-host-browser-and-control-ui-interop.md) | `72/70`                  |

### Native Windows (1/4)

| Status | Category                                                                                                                | Score (Coverage/Quality) |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [CLI](inventory/native-windows-cli-and-gateway/native-powershell-install-and-cli-entrypoints.md)                        | `72/66`                  |
| ➡️     | [Gateway Management](inventory/native-windows-cli-and-gateway/native-gateway-foreground-runtime-and-process-control.md) | `68/62`                  |
| ➡️     | [Networking](inventory/native-windows-cli-and-gateway/windows-host-networking-portproxy-and-remote-access.md)           | `58/56`                  |
| ➡️     | [Updates](inventory/native-windows-cli-and-gateway/windows-update-restart-handoff-and-package-locks.md)                 | `74/68`                  |

### Observability (3/5)

| Status | Category                                                                                                           | Score (Coverage/Quality) |
| ------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| ✅     | [Health and Repair](inventory/telemetry-diagnostics-and-observability/health-status-probes.md)                     | `80/76`                  |
| ✅     | [Logging](inventory/telemetry-diagnostics-and-observability/logging-log-tail-and-redaction.md)                     | `82/84`                  |
| ✅     | [Session Diagnostics](inventory/telemetry-diagnostics-and-observability/session-run-and-usage-diagnostics.md)      | `82/78`                  |
| ➡️     | [Diagnostic Collection](inventory/telemetry-diagnostics-and-observability/diagnostics-export-support-bundles.md)   | `76/74`                  |
| ➡️     | [Telemetry Export](inventory/telemetry-diagnostics-and-observability/diagnostic-events-hooks-and-trace-context.md) | `78/78`                  |

### Channel framework (5/8)

| Status | Category                                                                                                          | Score (Coverage/Quality) |
| ------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Channel Setup](inventory/channel-framework/channel-setup.md)                                                     | `84/78`                  |
| ✅     | [Inbound Access and Identity Gates](inventory/channel-framework/inbound-access-and-identity-gates.md)             | `80/76`                  |
| ✅     | [Conversation Routing and Delivery](inventory/channel-framework/conversation-routing-and-delivery.md)             | `77/71`                  |
| ✅     | [Outbound Delivery and Reply Pipeline](inventory/channel-framework/outbound-delivery-and-reply-pipeline.md)       | `82/75`                  |
| ✅     | [Status Health and Operator Controls](inventory/channel-framework/status-health-and-operator-controls.md)         | `82/78`                  |
| ➡️     | [Channel Actions Commands and Approvals](inventory/channel-framework/channel-actions-commands-and-approvals.md)   | `68/72`                  |
| ➡️     | [Group Thread and Ambient Room Behavior](inventory/channel-framework/group-thread-and-ambient-room-behavior.md)   | `76/68`                  |
| ➡️     | [Media Attachments and Rich Channel Data](inventory/channel-framework/media-attachments-and-rich-channel-data.md) | `68/70`                  |

### Slack (5/5)

| Status | Category                                                                                             | Score (Coverage/Quality) |
| ------ | ---------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Channel Setup and Operations](inventory/slack/app-install-auth-manifest-and-scopes.md)              | `74/68`                  |
| ✅     | [Access and Identity](inventory/slack/dm-pairing-and-sender-authorization.md)                        | `74/70`                  |
| ✅     | [Conversation Routing and Delivery](inventory/slack/channel-thread-routing-and-session-isolation.md) | `64/66`                  |
| ✅     | [Media and Rich Content](inventory/slack/media-attachments-files-and-vision.md)                      | `64/66`                  |
| ✅     | [Native Controls and Approvals](inventory/slack/slash-commands-and-native-command-routing.md)        | `72/70`                  |

### Discord (4/6)

| Status | Category                                                                                                         | Score (Coverage/Quality) |
| ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Channel Setup and Operations](inventory/discord/bot-setup-and-account-configuration.md)                         | `74/71`                  |
| ✅     | [Access and Identity](inventory/discord/dm-pairing-and-sender-authorization.md)                                  | `74/72`                  |
| ✅     | [Conversation Routing and Delivery](inventory/discord/guild-channel-routing-and-session-isolation.md)            | `74/72`                  |
| ✅     | [Media and Rich Content](inventory/discord/media-attachments-and-voice-message-handling.md)                      | `74/72`                  |
| ➡️     | [Native Controls and Approvals](inventory/discord/native-slash-commands-components-and-interactive-callbacks.md) | `58/72`                  |
| ➡️     | [Realtime Voice and Calls](inventory/discord/realtime-discord-voice-channels.md)                                 | `74/66`                  |

### Telegram (5/5)

| Status | Category                                                                                         | Score (Coverage/Quality) |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------ |
| ✅     | [Channel Setup and Operations](inventory/telegram/bot-setup-and-account-configuration.md)        | `76/70`                  |
| ✅     | [Access and Identity](inventory/telegram/dm-pairing-and-sender-authorization.md)                 | `76/68`                  |
| ✅     | [Conversation Routing and Delivery](inventory/telegram/group-forum-topic-and-session-routing.md) | `74/68`                  |
| ✅     | [Media and Rich Content](inventory/telegram/media-location-polls-and-rich-inputs.md)             | `74/72`                  |
| ✅     | [Native Controls and Approvals](inventory/telegram/inline-buttons-approvals-and-actions.md)      | `74/72`                  |

### OpenAI / Codex provider path (3/5)

| Status | Category                                                                                                                        | Score (Coverage/Quality) |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Model and Auth](inventory/openai-codex-provider-path/canonical-openai-model-routing-and-catalog.md)                            | `78/66`                  |
| ✅     | [Responses and Tool Compatibility](inventory/openai-codex-provider-path/codex-responses-transport-and-payload-compatibility.md) | `76/70`                  |
| ✅     | [Native Codex Harness](inventory/openai-codex-provider-path/native-codex-app-server-harness-and-thread-lifecycle.md)            | `82/72`                  |
| ➡️     | [Image and Multimodal Input](inventory/openai-codex-provider-path/image-generation-editing-and-multimodal-input.md)             | `80/72`                  |
| ➡️     | [Voice and Realtime Audio](inventory/openai-codex-provider-path/realtime-voice-transcription-and-speech.md)                     | `72/68`                  |

### Browser automation and exec/sandbox tools (2/3)

| Status | Category                                                                                                                   | Score (Coverage/Quality) |
| ------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Tool Invocation and Execution](inventory/browser-automation-and-exec-sandbox-tools/exec-routing-and-process-lifecycle.md) | `82/79`                  |
| ✅     | [Sandbox and Tool Policy](inventory/browser-automation-and-exec-sandbox-tools/sandbox-backends-and-workspace-isolation.md) | `76/72`                  |
| ➡️     | [Browser Automation](inventory/browser-automation-and-exec-sandbox-tools/browser-actions-snapshots-and-artifacts.md)       | `78/74`                  |

### Plugins (7/9)

| Status | Category                                                                                                                | Score (Coverage/Quality) |
| ------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| ✅     | [Installing and running plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/runtime-loading-and-lifecycle.md) | `86/84`                  |
| ✅     | [Bundled plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/bundled-plugin-discovery-and-inventory.md)       | `86/84`                  |
| ➡️     | [Canvas plugin](inventory/plugin-sdk-and-bundled-plugin-architecture/canvas-plugin.md)                                  | `76/66`                  |
| ✅     | [Plugin approvals](inventory/plugin-sdk-and-bundled-plugin-architecture/approval-and-security-boundaries.md)            | `84/86`                  |
| ✅     | [Provider and tool plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/provider-tool-plugin-architecture.md)  | `84/82`                  |
| ✅     | [Channel plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/channel-plugin-architecture.md)                  | `82/78`                  |
| ✅     | [Authoring and Packaging plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/public-sdk-api-and-subpaths.md)  | `77/74`                  |
| ✅     | [Publishing plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/distribution-release-and-compatibility.md)    | `79/82`                  |
| ➡️     | [Testing plugins](inventory/plugin-sdk-and-bundled-plugin-architecture/developer-testing-and-fixtures.md)               | `84/81`                  |

## Prioritized non-LTS candidates

This section ranks the currently non-LTS surface/category pairs that should be
prioritized for future LTS eligibility. It is based on the current taxonomy,
`inventory/**/scores.yaml`, and sentiment from local `discrawl` and `gitcrawl`
archives.

Current scan basis:

- Initial LTS slice: `68` categories.
- Total taxonomy: `279` categories.
- Non-LTS scan scope: `211` categories.
- `gitcrawl` freshness: synced through 2026-05-28.
- `discrawl` freshness: synced through 2026-05-29.

### First Wave

#### Docker / Podman hosting

- [Container Setup](inventory/docker-podman-hosting/docker-install-compose-and-first-run-setup.md): `74/76`
- [Container Operations](inventory/docker-podman-hosting/runtime-configuration-state-volumes-and-secrets.md): `76/70`
- [Image Release and Validation](inventory/docker-podman-hosting/image-build-release-packaging-and-attestations.md): `84/78`
- [Agent Sandbox and Tooling](inventory/docker-podman-hosting/containerized-agents-sandbox-and-tooling-support.md): `75/68`

Why: this is the strongest enterprise deployment gap outside the initial LTS
slice. Discord support sentiment repeatedly clusters around VPS, Docker, WSL,
volume persistence, secrets, update, and rollback confusion. GitHub also has a
current Docker gateway restart-loop issue, `#86612`.

#### Microsoft Teams

- [Channel Setup and Operations](inventory/microsoft-teams/setup-app-registration-credentials-admin-install.md): `58/64`
- [Access and Identity](inventory/microsoft-teams/dm-pairing-sender-authorization-config-writes.md): `60/62`
- [Conversation Routing and Delivery](inventory/microsoft-teams/team-channel-routing-mention-gates-sessions-thread-context.md): `68/66`
- [Media and Rich Content](inventory/microsoft-teams/media-attachments-file-consent-graph-file-flows.md): `62/58`
- [Native Controls and Approvals](inventory/microsoft-teams/actions-reactions-polls-approvals-group-management.md): `64/66`

Why: Teams has low current scores, but it is the obvious second enterprise
workplace channel after Slack. GitHub has strong concrete signal for channel
session behavior, multiple-bot support, attachment handling, managed identity,
and setup/admin complexity: `#81084`, `#71058`, `#65329`, `#67177`, and
`#85149`.

#### Cross-provider auth

- Anthropic provider path / [Provider Auth and Recovery](inventory/anthropic-provider-path/auth-onboarding-and-credential-profile-health.md): `78/70`
- Google provider path / [Provider Setup and Credentials](inventory/google-provider-path/provider-auth-credentials-and-operator-setup.md): `72/60`

Why: provider auth is one of the highest recurring Discord support themes.
Users get stuck on missing auth, fallback routing, cooldowns, stale profiles,
plaintext secrets, provider mismatch, and unclear recovery commands. These
categories are prerequisites for making any multi-provider enterprise harness
reliable.

#### Gateway Web App

- [Browser Access and Trust](inventory/browser-control-ui-and-webchat/gateway-connection-auth-device-pairing-and-origins.md): `84/68`
- [Configuration](inventory/browser-control-ui-and-webchat/config-schema-editing-and-safe-writes.md): `82/78`
- [Browser UI](inventory/browser-control-ui-and-webchat/control-ui-static-shell-routing-and-pwa.md): `74/72`
- [WebChat Conversations](inventory/browser-control-ui-and-webchat/chat-composer-session-model-controls-and-rendering.md): `78/66`
- [Operator Console](inventory/browser-control-ui-and-webchat/diagnostics-logs-update-and-activity.md): `78/74`

Why: this is the operator and admin surface for an enterprise deployment.
GitHub has open UX and runtime issues around auth gates, transcript loss,
uploads, CJK input and streaming, and partial reloads: `#85750`, `#72500`,
`#83344`, `#81606`, `#86035`, `#60247`, and `#86435`.

#### Automation: cron, hooks, tasks, polling

- [Cron Jobs](inventory/automation-cron-hooks-tasks-polling/cron-job-lifecycle.md): `82/73`
- [Background Tasks and Flows](inventory/automation-cron-hooks-tasks-polling/background-task-ledger.md): `73/68`
- [Event Ingress](inventory/automation-cron-hooks-tasks-polling/channel-polling-webhooks.md): `65/58`
- [Automation Hooks](inventory/automation-cron-hooks-tasks-polling/internal-hooks.md): `78/72`
- [Heartbeat](inventory/automation-cron-hooks-tasks-polling/heartbeat-commitments.md): `82/72`

Why: enterprise agents need durable scheduled work, alerting, and recovery.
GitHub has current signal for startup races, duplicate names, silent data loss,
status visibility, elevated scoping, and owner-tool stripping: `#75889`,
`#76160`, `#83538`, `#51184`, `#41484`, and `#72954`.

#### TUI

- [Runtime Modes](inventory/tui-and-terminal-ux/launch-modes-and-cli-entrypoints.md): `78/72`
- [Input and Commands](inventory/tui-and-terminal-ux/composer-keybindings-and-input-editing.md): `76/70`
- [Session Management](inventory/tui-and-terminal-ux/session-lifecycle-history-and-resume.md): `80/68`
- [Local Shell Execution](inventory/tui-and-terminal-ux/local-shell-execution-and-approval-boundary.md): `70/76`
- [Rendering and Output Safety](inventory/tui-and-terminal-ux/streaming-message-rendering-and-tool-cards.md): `76/70`

Why: TUI is a real operator-facing surface with broad docs and decent baseline
coverage, but it is still less proven as a primary supported workflow than the
CLI and Gateway host paths in the initial slice. Promote it when launch modes,
command/input behavior, session resume, local shell boundaries, and streaming
rendering are treated as one terminal-native support promise.

### Second wave

#### macOS Gateway host

- [Gateway Service Lifecycle](inventory/macos-gateway-host/launchagent-service-lifecycle.md): `82/76`
- [Local Gateway Integration](inventory/macos-gateway-host/local-gateway-mode-host-configuration.md): `76/82`
- [Diagnostics and Observability](inventory/macos-gateway-host/diagnostics-logs-operator-observability.md): `80/83`
- [CLI Setup](inventory/macos-gateway-host/cli-install-runtime-prerequisites.md): `82/76`
- [Remote Gateway Mode](inventory/macos-gateway-host/remote-gateway-mode-transport.md): `72/82`

Why: Linux is the cleaner first LTS host, but macOS has heavy real-world support
volume and strong desktop-gateway relevance. Current issues include LaunchAgent
reporting, bind behavior, cert and update drift, external-volume failures,
Homebrew/runtime drift, unrecoverable upgrades, restart loops, and install
failures: `#81751`, `#65619`, `#86579`, `#87199`, `#75250`, `#85027`,
`#73673`, and `#60398`.

#### Browser automation and exec/sandbox tools

- [Browser Automation](inventory/browser-automation-and-exec-sandbox-tools/browser-actions-snapshots-and-artifacts.md): `78/74`

Why: the initial LTS slice already includes core tool invocation and sandbox
policy, but browser execution is part of a practical enterprise agent harness.
Open issues include sandbox/runtime mismatch, non-Docker backend support,
noVNC/CJK behavior, upload access, timeouts, and Control UI responsiveness.

#### Web search tools

- [Network Safety](inventory/web-search-tools/network-safety-ssrf-redirects-and-untrusted-content.md): `84/84`
- [Tool Availability and Fetch](inventory/web-search-tools/tool-exposure-policy-and-runtime-tool-wiring.md): `82/80`
- [Search Providers](inventory/web-search-tools/bundled-structured-search-providers.md): `76/72`
- [Setup and Diagnostics](inventory/web-search-tools/operator-setup-provider-selection-and-credential-repair.md): `74/70`

Why: web fetch and structured search are useful for enterprise research
workflows, but they are outside the minimal first support promise. Promote this
surface when network safety, runtime tool wiring, provider selection, timeout
behavior, and operator repair are accepted together. GitHub has search timeout,
provider-native tool, tool-drop, and provider option signal:
`#87505`, `#23353`, `#77826`, and `#84872`.

#### Gateway runtime

- [Nodes and Remote Capabilities](inventory/gateway-runtime/node-transport-and-capability-relay.md): `84/63`

Why: node pairing and remote node capability relay still harden the perimeter
around the existing Gateway LTS promise and need separate operational proof.

### Lower priority for LTS

Observability should add Diagnostic Collection and
Telemetry Export hardening after the runtime and channel priorities above.
Plugin SDK should add Testing plugins, Packaging plugins, then Publishing
plugins; this matters for ecosystem durability, but has weaker direct
enterprise sentiment than Docker, Teams, Slack, and provider auth.

Continue to defer mobile apps, voice, media generation, regional channels,
iMessage, Matrix, WhatsApp, and long-tail providers unless a specific customer
commitment changes the support boundary.

## Interpretation

This LTS slice is intentionally conservative. It promises enough for an
enterprise to run a usable agent harness with Gateway, auth and policy,
session/runtime execution, operational diagnostics, Linux hosting, Slack,
Discord, Telegram, the OpenAI/Codex provider path, and tool execution controls.

Categories outside this slice can keep shipping, but should not be part of the
initial LTS guarantee until their owner, support boundary, upgrade behavior,
and enterprise failure modes are explicitly accepted.
