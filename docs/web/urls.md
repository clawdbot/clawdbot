---
summary: "Control UI routes, focus presentations, stable session links, and connection handoff parameters"
read_when:
  - You need to bookmark or share a Control UI session
  - You are adding or changing a Control UI route
  - You need a terminal, desktop, approval, onboarding, or remote Gateway URL
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
/chat/main/telegram/12345
/chat/main/cron/nightly/run/8821
/chat/main
```

The path grammar is:

```text
/<namespace>/<agentId>
/<namespace>/<agentId>/<sessionRef>
/<namespace>/<agentId>/<restSegment>/<restSegment>...
```

`<namespace>` is either `/chat` or `/dashboard`. The first form opens that
agent's main session. The other forms encode one immutable session key in one of
two ways.

The short-id form applies when the session key's rest, everything after
`agent:<agentId>:`, ends in a UUID. `<sessionRef>` is an optional display-name
slug plus a short id, such as `deploy-monitor-6db92d48`. The short id is the
authoritative part: at least eight lowercase hexadecimal characters from the
start of the key's trailing UUID, with UUID dashes omitted. Longer prefixes up
to all 32 hexadecimal characters are accepted. The row's rotating `sessionId`
is not part of the URL identity.

Every other key uses the literal-key form. Each colon-delimited segment after
`agent:<agentId>:` becomes one URL-encoded path segment. For example,
`agent:main:telegram:12345` becomes `/chat/main/telegram/12345`, and
`agent:main:cron:nightly:run:8821` becomes
`/chat/main/cron/nightly/run/8821`.

Literal rest segments exactly equal to `.` or `..` use `~dot` and `~dotdot` so
browsers cannot collapse them as relative path segments. A literal segment that
starts with `~` doubles that leading character to keep the encoding reversible.
When an otherwise literal one-segment rest could be mistaken for a short id,
the builder inserts `~key` before it, for example
`agent:main:release-deadbeef` becomes
`/chat/main/~key/release-deadbeef`. The marker forces literal interpretation
and appears only when the unescaped form would be ambiguous.

The reserved single-segment literal rest names are `main`, `global`, `boot`,
and `sessions`. The configured `session.mainKey` joins that set at runtime.
Exactly one segment after the agent id is literal when it is reserved or does
not contain a valid short id; otherwise it is a short reference. Two or more
segments after the agent id are always literal.

Only the configured `session.mainKey` collapses to the agent-only main-session
path. With `session.mainKey: "workspace"`, `agent:research:workspace` becomes
`/chat/research`, while the distinct key `agent:research:main` remains the
literal path `/chat/research/main`.

### Stability contract

The following parts are stable URL contracts:

- The `/chat` and `/dashboard` namespace words.
- The key UUID short id in short-id URLs.
- The arity and short-versus-literal parsing rules above.

In short-id form, the agent segment is decorative and the slug is almost
decorative. Neither identifies the session on its own, and both may change
without notice. The one exception is a tie: if the short id matches more than
one session and exactly one of them still carries the slug in the link, that
session is used, so a generated link keeps working even when two ids happen to
share a prefix. A slug that matches none or several of the tied sessions is
ignored and the disambiguation view is shown. After resolution, the Control UI
replaces the address bar with the current agent id and current display-name slug
without adding a browser-history entry.

In literal-key form, the agent segment is authoritative because it is part of
the reconstructed session key. The remaining literal segments are authoritative
too. A slug, when present, is always decorative; literal-key forms do not
synthesize one.

As a best-effort convenience, an unescaped one-segment literal that does not
resolve as an exact session key is also checked against display-name slugs. One
exact slug match is replaced in the address bar with its full
`/<namespace>/<agentId>/<slug>-<shortId>` reference. If several sessions share
the slug, the UI shows the same disambiguation view used for short-id ties
instead of guessing. Exact short-id and literal-key references always win over
slug matching.

If one short id matches more than one session and the slug does not settle it,
the UI does not guess. It shows a small disambiguation view with the matching
display names, agents, and longer id prefixes. Use a longer prefix to make the
URL unique. Current Gateways return at most ten recent candidates; when that
bound is reached, the view treats the result as incomplete instead of guessing.
Against an older Gateway that predates short-id resolve support, the UI falls
back to the prior bounded list search, scanning at most five pages of results.
It likewise reports an incomplete search instead of guessing when that fallback
cannot prove uniqueness.

To continue one of these links in the terminal or attach a coding harness, see
[Session synchronization and attachment](/concepts/session-attachment).

Canonical links do not use `?session=` or `?face=`. Released links such as
`/chat?session=<sessionKey>` are accepted only at the application boundary as a
migration aid and immediately rewritten, without adding browser history, to the
canonical path. The released `?face=dashboard` companion selects the
`/dashboard` namespace during that rewrite. Loaders and page code never read the
query-form identity, and new links must not emit it. The Sessions list keeps its
own `?session=` parameter because that parameter expands a row; it is not a
session deep link. The one-shot composer value `?draft=` remains supported on
chat and dashboard session paths.

## Focus presentation routes

A focus route renders one supported content surface without the normal Control
UI application chrome. Focus presentation is separate from browser fullscreen:
opening a focus route does not invoke the browser Fullscreen API.

Insert `/focus` immediately after the configured Control UI base path. Removing
it returns the corresponding normal route when one exists:

```text
/dashboard/roboclaw/the-daily-claw-6d7c9ccb
/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb

/openclaw/dashboard/roboclaw/the-daily-claw-6d7c9ccb
/openclaw/focus/dashboard/roboclaw/the-daily-claw-6d7c9ccb
```

Dashboard focus routes use the complete canonical `/dashboard` grammar above:

```text
/focus/dashboard/<agentId>
/focus/dashboard/<agentId>/<sessionRef...>
```

The Control UI removes the focus modifier before passing the dashboard route to
the canonical session resolver. Canonical address replacement and ambiguity
candidate links preserve `/focus`. Missing, ambiguous, and unavailable sessions
remain visible, and the dashboard is not read until the session resolves to a
canonical key.

The other focus targets are:

```text
/focus/terminal

/focus/desktop
/focus/desktop/source/<encodedSource>
/focus/desktop/session/<encodedExactSessionKey>
/focus/desktop/control
/focus/desktop/control/source/<encodedSource>
/focus/desktop/control/session/<encodedExactSessionKey>
```

Encode desktop source and exact-session-key values with `encodeURIComponent` so
each occupies one path segment. Empty source and session values are omitted. If
a native caller supplies both non-empty values, the source form wins. The
optional `control` segment requests initial control; it does not grant control
or authorize the connection.

The focus target and desktop identity or options are path-only. Credentials do
not belong in these URLs. Each target keeps the startup, authentication,
permission, and capability checks of its normal or embedded surface. In
particular, the terminal still requires `gateway.terminal.enabled` and an
`operator.admin` connection.

Stable releases previously emitted `/?view=terminal`. The Control UI accepts
that form only at the application root (or `<basePath>/?view=terminal`) and
immediately replaces it in browser history with `/focus/terminal` under the
same base path, removing the legacy `view` parameter. New links must use
`/focus/terminal`. The query form is not recognized on other application
paths, and the removed desktop and dashboard query forms are not accepted.

`/focus` and unsupported `/focus/*` targets show an error without the ordinary
application shell. They do not open a normal application route.

## Route table

This table lists every Control UI application route. A dash means the route has
no route-specific URL parameters.

| Page                | Canonical path              | Aliases                   | Parameters or dynamic forms                                    |
| ------------------- | --------------------------- | ------------------------- | -------------------------------------------------------------- |
| Chat                | `/chat`                     | -                         | Key-backed session forms above; `?draft=<text>`                |
| Dashboard           | `/dashboard`                | -                         | Key-backed session forms above; `?draft=<text>`                |
| Dashboards          | `/dashboards`               | -                         | -                                                              |
| Ask OpenClaw        | `/custodian`                | -                         | `?intent=new-agent`, `?onboarding=1`                           |
| New session         | `/new`                      | -                         | `?agent=<agentId>`, `?catalog=<catalogId>`                     |
| Activity            | `/activity`                 | -                         | `?view=run&run=<run-id>`, `?view=run&execution=<execution-id>` |
| Apps                | `/apps`                     | -                         | -                                                              |
| Portals             | `/portals`                  | -                         | -                                                              |
| Agents              | `/settings/agents`          | `/agents`                 | `/settings/agents/<agentId>[/<panel>]`                         |
| Channels            | `/settings/channels`        | `/channels`               | Shared settings parameters below                               |
| Connection          | `/settings/connection`      | -                         | Shared settings parameters below                               |
| Legacy General      | `/settings/general`         | `/config`                 | Redirects to Appearance → Language                             |
| Profile             | `/settings/profile`         | `/profile`                | Shared settings parameters below                               |
| Communications      | `/settings/communications`  | `/communications`         | Shared settings parameters below                               |
| Appearance          | `/settings/appearance`      | `/appearance`             | Shared settings parameters below                               |
| Notifications       | `/settings/notifications`   | -                         | Shared settings parameters below                               |
| Security            | `/settings/security`        | -                         | Shared settings parameters below                               |
| Secrets             | `/settings/secrets`         | -                         | Shared settings parameters below                               |
| Advanced            | `/settings/advanced`        | -                         | Shared settings parameters below                               |
| Approvals           | `/settings/approvals`       | -                         | Shared settings parameters below                               |
| Automation settings | `/settings/automation`      | `/automation`             | Shared settings parameters below                               |
| MCP                 | `/settings/mcp`             | `/mcp`                    | Shared settings parameters below                               |
| Memory              | `/settings/memory`          | -                         | `/settings/memory/memories\|dreams\|settings`                  |
| Infrastructure      | `/settings/infrastructure`  | `/infrastructure`         | Shared settings parameters below                               |
| Labs                | `/settings/labs`            | -                         | Shared settings parameters below                               |
| About               | `/settings/about`           | -                         | Shared settings parameters below                               |
| AI and agents       | `/settings/ai-agents`       | `/ai-agents`              | Shared settings parameters below                               |
| Model setup         | `/settings/model-setup`     | `/model-setup`            | `?firstRun=1`                                                  |
| Model providers     | `/settings/model-providers` | `/model-providers`        | Shared settings parameters below                               |
| Import memory       | `/memory-import`            | `/settings/memory-import` | -                                                              |
| Workboard           | `/workboard`                | -                         | `/workboard/<boardId>`                                         |
| Worktrees           | `/worktrees`                | `/settings/worktrees`     | -                                                              |
| Sessions            | `/sessions`                 | `/settings/sessions`      | `?session=<sessionKey>`, `?status=archived\|all`               |
| Usage               | `/usage`                    | -                         | -                                                              |
| Debug               | `/debug`                    | -                         | -                                                              |
| Logs                | `/logs`                     | -                         | -                                                              |
| Skill Workshop      | `/skills/workshop`          | -                         | -                                                              |
| Skills              | `/skills`                   | -                         | -                                                              |
| Plugins             | `/settings/plugins`         | -                         | `/settings/plugins/discover`                                   |
| Automations         | `/cron`                     | -                         | -                                                              |
| Tasks               | `/tasks`                    | -                         | -                                                              |
| Devices             | `/settings/devices`         | `/nodes`                  | Shared settings parameters below                               |
| Plugin tab host     | `/plugin`                   | -                         | `?plugin=<pluginId>&id=<tabId>`                                |

Settings routes that use schema-backed deep links accept `?section=<section>`,
`?advanced=1`, and `#<setting-id>`. These values select content within the page;
they do not change the route identity.

The retired General route and its `/config` alias are replaced once with
`/settings/appearance?section=__appearance__#settings-language`. The historical
`#settings-general-model` target instead lands on the Models behavior section.

Memory tabs use the paths in the table instead of `?tab=`. Older Memory links
with `?tab=memories|dreams|settings`, `?tab=dreaming`, `?tab=search`, or
`?section=memory` are replaced once with the corresponding path while keeping
any setting anchor.

Plugin catalog tabs also use paths instead of `?tab=`. Older links with
`?tab=discover|installed` are replaced once with the corresponding path while
keeping other query parameters and the fragment.

Agent selection and its `overview|files|tools|skills|channels|cron|memory`
panels use paths. Older links with `?agent=<agentId>` are replaced once with
the agent path while keeping other query parameters and the fragment.

## Other special documents and startup modes

These Gateway-served documents sit outside the application route table:

- `/?onboarding=1` opens the first-run onboarding presentation.
- `/approve/<approvalId>` opens a standalone approval document. With a base
  path, use `<basePath>/approve/<approvalId>`. The id identifies an approval but
  never authorizes it; normal Gateway authentication still applies.

Registered exact and prefix plugin HTTP routes can own `/focus` and
`/focus/*`. After plugin authentication and dispatch decline a request, the
Gateway uses those paths as the Control UI focus fallback: unclaimed `GET` and
`HEAD` requests serve the Control UI document, while other methods return
`404`. Every unclaimed method returns `404` when Control UI serving is
disabled. Lookalikes such as `/focused` are not part of the focus fallback.

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
