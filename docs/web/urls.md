---
summary: "Control UI URL routes, stable session-link grammar, and connection handoff parameters"
read_when:
  - You need to bookmark or share a Control UI session
  - You are adding or changing a Control UI route
  - You need a terminal, approval, onboarding, or remote Gateway URL
title: "Control UI URLs"
---

The Control UI uses readable paths for pages and session links. A configured
`gateway.controlUi.basePath` prefixes every path below. For example, `/chat/main`
becomes `/openclaw/chat/main` when the base path is `/openclaw`.

## Session and dashboard URLs

Chat and dashboard views are parallel route namespaces:

```text
/chat/main/deploy-monitor-6db92d48
/dashboard/main/deploy-monitor-6db92d48
/dashboard/6db92d48
/chat/main
```

The path grammar is:

```text
/<namespace>/<agentId>
/<namespace>/<sessionRef>
/<namespace>/<agentId>/<sessionRef>
```

`<namespace>` is either `/chat` or `/dashboard`. The first form opens that
agent's main session. In a one-segment form, a segment ending in at least eight
hexadecimal characters is a session reference; every other value is an agent
id. The two-segment form always treats the second segment as a session reference.

`<sessionRef>` is a short session id with an optional slug, such as
`deploy-monitor-6db92d48`. The short id is the authoritative part. It is the
first eight lowercase hexadecimal characters of the session UUID. Longer
prefixes and the full UUID are also accepted.

### Stability contract

The following parts are stable URL contracts:

- The `/chat` and `/dashboard` namespace words.
- The short session id.
- The one-segment and two-segment arity rules above.

The agent segment and slug are explicitly decorative. They may change without
notice and must not be used to identify or validate a session. This lets agent
renames and session-title changes preserve old bookmarks. After resolution, the
Control UI replaces the address bar with the current agent id and current
display-name slug without adding a browser-history entry.

If one short id matches more than one session, the UI does not guess. It shows a
small disambiguation view with the matching display names, agents, and longer id
prefixes. Use a longer prefix to make the URL unique.

As of this release, `?session=` and `?face=` are removed. There is no redirect,
fallback reader, or dual URL format. The Sessions list keeps its own `?session=`
parameter because that parameter expands a row; it is not a session deep link.
The one-shot composer value `?draft=` remains supported on chat and dashboard
session paths.

## Route table

This table lists every Control UI application route. A dash means the route has
no route-specific URL parameters.

| Page                | Canonical path              | Aliases                   | Parameters or dynamic forms                      |
| ------------------- | --------------------------- | ------------------------- | ------------------------------------------------ |
| Chat                | `/chat`                     | -                         | Session forms above; `?draft=<text>`             |
| Dashboard           | `/dashboard`                | -                         | Session forms above; `?draft=<text>`             |
| Ask OpenClaw        | `/custodian`                | -                         | `?intent=new-agent`, `?onboarding=1`             |
| New session         | `/new`                      | -                         | `?agent=<agentId>`, `?catalog=<catalogId>`       |
| Activity            | `/activity`                 | -                         | -                                                |
| Apps                | `/apps`                     | -                         | -                                                |
| Agents              | `/settings/agents`          | `/agents`                 | `?agent=<agentId>`                               |
| Channels            | `/settings/channels`        | `/channels`               | Shared settings parameters below                 |
| Connection          | `/settings/connection`      | -                         | Shared settings parameters below                 |
| General settings    | `/settings/general`         | `/config`                 | Shared settings parameters below                 |
| Profile             | `/settings/profile`         | `/profile`                | Shared settings parameters below                 |
| Communications      | `/settings/communications`  | `/communications`         | Shared settings parameters below                 |
| Appearance          | `/settings/appearance`      | `/appearance`             | Shared settings parameters below                 |
| Notifications       | `/settings/notifications`   | -                         | Shared settings parameters below                 |
| Security            | `/settings/security`        | -                         | Shared settings parameters below                 |
| Advanced            | `/settings/advanced`        | -                         | Shared settings parameters below                 |
| Approvals           | `/settings/approvals`       | -                         | Shared settings parameters below                 |
| Automation settings | `/settings/automation`      | `/automation`             | Shared settings parameters below                 |
| MCP                 | `/settings/mcp`             | `/mcp`                    | Shared settings parameters below                 |
| Infrastructure      | `/settings/infrastructure`  | `/infrastructure`         | Shared settings parameters below                 |
| Labs                | `/settings/labs`            | -                         | Shared settings parameters below                 |
| About               | `/settings/about`           | -                         | Shared settings parameters below                 |
| AI and agents       | `/settings/ai-agents`       | `/ai-agents`              | Shared settings parameters below                 |
| Model setup         | `/settings/model-setup`     | `/model-setup`            | `?firstRun=1`                                    |
| Model providers     | `/settings/model-providers` | `/model-providers`        | Shared settings parameters below                 |
| Import memory       | `/memory-import`            | `/settings/memory-import` | -                                                |
| Workboard           | `/workboard`                | -                         | `/workboard/<boardId>`                           |
| Worktrees           | `/worktrees`                | `/settings/worktrees`     | -                                                |
| Sessions            | `/sessions`                 | `/settings/sessions`      | `?session=<sessionKey>`, `?status=archived\|all` |
| Usage               | `/usage`                    | -                         | -                                                |
| Debug               | `/debug`                    | -                         | -                                                |
| Logs                | `/logs`                     | -                         | -                                                |
| Skill Workshop      | `/skills/workshop`          | -                         | -                                                |
| Skills              | `/skills`                   | -                         | -                                                |
| Plugins             | `/settings/plugins`         | -                         | `?tab=discover\|installed`                       |
| Automations         | `/cron`                     | -                         | -                                                |
| Tasks               | `/tasks`                    | -                         | -                                                |
| Devices             | `/settings/devices`         | `/nodes`                  | Shared settings parameters below                 |
| Plugin tab host     | `/plugin`                   | -                         | `?plugin=<pluginId>&id=<tabId>`                  |

Settings routes that use schema-backed deep links accept `?section=<section>`,
`?advanced=1`, and `#<setting-id>`. These values select content within the page;
they do not change the route identity.

## Special documents and startup modes

These Gateway-served documents sit outside the application route table:

- `/?onboarding=1` opens the first-run onboarding presentation.
- `/?view=terminal` opens the full-screen terminal-only document used by the
  mobile apps. Availability still requires `gateway.terminal.enabled` and
  `operator.admin`.
- `/approve/<approvalId>` opens a standalone approval document. With a base
  path, use `<basePath>/approve/<approvalId>`. The id identifies an approval but
  never authorizes it; normal Gateway authentication still applies.

The approval namespace is reserved ahead of plugin HTTP routes for all HTTP
methods. When Control UI serving is disabled, it returns `404` instead of
falling through to a plugin route.

## Remote Gateway handoff

The Vite development UI can connect to a different Gateway:

```text
http://localhost:5173/?gatewayUrl=ws%3A%2F%2F<gateway-host>%3A18789
http://localhost:5173/?gatewayUrl=wss%3A%2F%2F<gateway-host>%3A18789#token=<gateway-token>
```

URL-encode a full `ws://` or `wss://` value. `gatewayUrl` is accepted only in a
top-level window, stored after load, and removed from the address bar. Prefer
`#token=` because fragments do not enter HTTP request logs or Referer headers.
The legacy `?token=` handoff remains a bootstrap-only credential fallback and
is stripped immediately. Passwords stay in memory only.

When `gatewayUrl` selects another Gateway, the UI does not fall back to local
configuration or environment credentials. Provide the remote Gateway's token
or password explicitly, and use `wss://` behind TLS.

## Related

- [Control UI](/web/control-ui)
- [Dashboard](/web/dashboard)
- [Session dashboards](/web/dashboards)
