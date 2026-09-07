---
summary: "Top-level and appServer config fields for the Codex plugin"
read_when:
  - You need the supported Codex plugin config fields
  - You are setting an appServer field and want its default
  - You are enabling Codex managed networking
title: "Codex plugin config fields"
sidebarTitle: "Config fields"
---

Supported `plugins.entries.codex.config` fields and their defaults. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Config fields

Supported top-level Codex plugin fields:

| Field                      | Default        | Meaning                                                                                  |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `codexDynamicToolsLoading` | `"searchable"` | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context. |
| `codexDynamicToolsExclude` | `[]`           | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.              |
| `codexPlugins`             | disabled       | Native Codex plugin/app support for migrated source-installed curated plugins.           |
| `sessionCatalog`           | enabled        | Sidebar discovery for native Codex sessions on this Gateway and eligible paired nodes.   |
| `supervision`              | disabled       | Agent-facing native-session transcript and write-control policy.                         |

Supported `appServer` fields:

| Field                            | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                      | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                                                   |
| `homeScope`                      | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.                                        |
| `command`                        | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                                                                                                                                                                                                                                                                                                                       |
| `args`                           | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `url`                            | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                                                             |
| `authToken`                      | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                                                                 |
| `headers`                        | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                                                                  |
| `clearEnv`                       | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. OpenClaw keeps the selected `CODEX_HOME` and inherited `HOME` for local launches.                                                                                                                                                                                                              |
| `codeModeOnly`                   | `false`                                                | Opt into Codex's code-mode-only tool surface. Ordinary OpenClaw dynamic tools remain available through nested `tools.*` calls; `openclaw_direct` tools stay directly model-visible.                                                                                                                                                                                                                                                |
| `remoteWorkspaceRoot`            | unset                                                  | Remote Codex app-server workspace root. OpenClaw maps the local cwd into this root and transfers authoritative remote attachments over an output-capped, no-shell `command/exec` reader. Paths escaping either workspace, symbolic links, oversized files, and unbounded attachment batches fail closed; uploads retain the configured channel identity and app-server request timeout.                                            |
| `requestTimeoutMs`               | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                                                        |
| `mode`                           | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution. Local stdio requirements that omit `danger-full-access`, `never` approval, or the `user` reviewer make the implicit default guardian.                                                                                                                                                                                                                                              |
| `approvalPolicy`                 | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start/resume/turn. Guardian defaults prefer `"on-request"` when allowed.                                                                                                                                                                                                                                                                                                               |
| `sandbox`                        | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start/resume. Guardian defaults prefer `"workspace-write"` when allowed, otherwise `"read-only"`. When an OpenClaw sandbox is active, `danger-full-access` turns use Codex `workspace-write` with network access derived from the OpenClaw sandbox egress setting.                                                                                                                        |
| `approvalsReviewer`              | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed, otherwise `guardian_subagent` or `user`. `guardian_subagent` remains a legacy alias.                                                                                                                                                                                                                                                                 |
| `serviceTier`                    | unset                                                  | Native Codex app-server preference only. Any non-empty string passes through for forward compatibility; documented values are `"priority"` and `"flex"`. `null` clears the override, and legacy `"fast"` normalizes to `"priority"`. This is neither the shared Fast-mode setting nor a direct embedded OpenAI setting. A shared Fast run control supersedes it with `priority` or `null`, or decides per model call in auto mode. |
| `networkProxy`                   | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                                                                |
| `experimental.sandboxExecServer` | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                                                               |

`appServer.networkProxy` is explicit because it changes the Codex sandbox
contract. When enabled, OpenClaw also sets `features.network_proxy.enabled`
and `default_permissions` in the Codex thread config so the generated
permission profile can start Codex managed networking. By default, OpenClaw
generates a collision-resistant `openclaw-network-<fingerprint>` profile
name from the profile body; use `profileName` only when a stable local name
is required.

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            sandbox: "workspace-write",
            networkProxy: {
              enabled: true,
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              unixSockets: {
                "/tmp/proxy.sock": "allow",
                "/tmp/blocked.sock": "none",
              },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    },
  },
}
```

If the normal app-server runtime would be `danger-full-access`, enabling
`networkProxy` uses workspace-style filesystem access for the generated
permission profile: Codex managed network enforcement is sandboxed
networking, so a full-access profile would not protect outbound traffic.
Domain entries use `allow` or `deny`; Unix socket entries use Codex's
`allow` or `none` values.
