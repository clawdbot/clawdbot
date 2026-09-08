---
summary: "Control UI routes, focus presentations, stable session links, and connection handoff parameters"
read_when:
  - You need to bookmark or share a Control UI session
  - You need to publish or revoke a world-readable session transcript
  - You run the Control UI behind a login proxy and need social previews to unfurl
  - You are adding or changing a Control UI route
  - You need a terminal, desktop, approval, onboarding, or remote Gateway URL
title: "Control UI URLs"
---

The Control UI uses readable paths for pages and session links. A configured
`gateway.controlUi.basePath` prefixes every path below. For example, `/chat/main`
becomes `/openclaw/chat/main` when the base path is `/openclaw`.

## Session and dashboard URLs

**Copy → Session link** uses the connected Gateway's public Control UI address
when `gateway.publicOrigin` is configured, including its
`gateway.controlUi.basePath`. This keeps links shareable when the desktop app
connects through a local SSH tunnel. Without a public origin, copied links use
the connected Gateway's HTTP(S) address; a tunnel-only address remains local.
Normal navigation and **Open in** continue using the current UI. Copied links
contain no connection credentials, and recipients still need Gateway access.

The Dashboards gallery adds `?dashboard=expanded` to the owning task's chat
link, for example `/chat/main/deploy-monitor-6db92d48?dashboard=expanded`.
This makes Dashboard the main view and focuses it. **Restore split** brings
the side panel alongside the dashboard. Ordinary task navigation restores the browser's
saved task arrangement instead of forcing a dashboard-only view.

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
when a reference could otherwise be ambiguous. Builders also use it for the
ordinary key `agent:research:global`, producing `/chat/research/~key/global`
to distinguish it from the raw `global` home-session key, which uses
`/chat/research`. Existing `/chat/research/global` literal links still resolve
to `agent:research:global`.

The reserved single-segment literal rest names are `main`, `global`, `boot`,
and `sessions`. Exactly one segment after the agent id is literal when it is
reserved or does not contain a valid short id; otherwise it is a short reference.
Two or more segments after the agent id are always literal.

The canonical main session `agent:research:main` uses the agent-only path
`/chat/research`. Custom `session.mainKey` values are ignored by config loading;
setting it to `"workspace"` does not make `/chat/research/workspace` a main-session
route. It follows ordinary session lookup; if no existing session matches, it shows
**Session not found**.

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

Opening the Control UI at `/` or `/chat` restores the browser's last selected
session. If that session no longer exists, the UI opens its agent's main session;
if the agent was removed, it uses the current agent instead. Explicit links to
missing sessions keep showing the "Session not found" recovery page.

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

### Native catalog links

Native catalog threads use the agent path with a source query:

```text
/chat/<agentId>?catalog=<catalogId>&host=<hostId>&thread=<threadId>
```

URL-encode each query value. The agent in the path owns the OpenClaw pane,
including catalog reads and continuation; `catalog`, `host`, and `thread`
identify the native source. Opening the same source under different agents
keeps their panes and drafts separate, including in split view. Continuing a
thread navigates to the adopted OpenClaw session link. The same catalog query
also works under `/dashboard/<agentId>`.

## Social previews

Use **Copy → Preview link** in a session's menu to share a link with an OpenClaw
social card. It opens a small public landing page; **Open dashboard** or
**Open session** then takes the recipient to the normal authenticated view.
**Copy → Session link** still copies the direct link.

For example, `/share/dashboard/main/deploy-monitor-6db92d48` previews
`/dashboard/main/deploy-monitor-6db92d48`. A configured Control UI base path
prefixes both paths. The preview serves Open Graph metadata and a 1200 × 630 PNG
at `/share/card.png`, without requiring JavaScript or a Gateway connection.

The card shows generic OpenClaw branding, not the session's title, messages,
dashboard widgets, or screenshots. Preview requests never look up session state,
so the page does not reveal whether the target exists. The link itself still
contains the session route and, for catalog sessions, the catalog routing fields.
Treat those URLs as information you are choosing to share.

### Behind a login proxy

Link crawlers cannot sign in to your proxy. Allow anonymous `GET` and `HEAD`
requests **only** to the Control UI's `/share/*` namespace (for example,
`/openclaw/share/*` for a `/openclaw` base path). Keep the dashboard, WebSocket,
bootstrap, API, and other routes protected. Do not grant crawlers authenticated
access based on their User-Agent.

For Cloudflare Access, use a separate application matching that public path with
a Bypass policy; keep the existing authenticated application for the rest of the
host. See [Cloudflare's application path rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
This is an operator deployment step; OpenClaw does not change proxy policies.

Set the existing `gateway.publicOrigin` to your external HTTP(S) origin when TLS
terminates at the proxy, so the image and canonical URLs use the public HTTPS
address. Without it, previews use the request's Host and direct connection
protocol; forwarded headers are not trusted for public preview URLs.

Verify both the preview URL and its `/share/card.png` return `200` without
cookies, then check that opening the dashboard still requires login. If a chat
app shows the login page or no image, check for proxy redirects on both preview
requests. Ordinary dashboard URLs remain protected and do not gain crawler
access from this feature.

## Public session transcripts

Session creators and Gateway admins can open the session's sharing menu and select
**Public access → Enable public access**. Confirming publishes the session's
existing and future conversation text to anyone with its public URL. Recipients
do not need an account or Gateway credentials. **Copy public link** copies that
URL; **Disable public access** revokes it. The chat header shows **Public** while
access is enabled.

Assigning another owner does not transfer public-sharing authority. If the public
controls are unavailable, confirm that the session is saved, is not incognito,
and you are its creator or a Gateway admin. See
[Multi-user mode](/concepts/multi-user#world-readable-session-links).

Public access is separate from teammate visibility and editing permissions.
Publishing does not let anonymous visitors send messages, invoke tools, open
private dashboards, or connect to the Gateway. Incognito sessions cannot be
published. Review the conversation before enabling public access: text can
contain sensitive information, and disabling access cannot recall saved copies.

The public page shows user messages and assistant final answers, with Markdown
formatting. Tool output, reasoning, files, images, executable widgets, internal
metadata, and hidden messages are omitted. Recognized credential patterns are
redacted, but this is not a guarantee that all sensitive text is detected.
The latest view refreshes every 15 seconds. **Older messages** opens earlier
pages without automatic refresh; **Back to latest** returns to the live view.
Each page is bounded, and oversized content is explicitly marked as omitted.
The initial page and its social metadata work without JavaScript.

Public URLs have this form, prefixed by the configured Control UI base path:

```text
/share/session?token=<opaque-publication-token>
```

The token is an encrypted bearer capability. It does not expose the agent,
session key, session ID, or internal publication ID in the URL. Anyone who has
the complete URL can read the published text, so handle it like any other
public link. Copying the link again can produce a different token for the same
publication; every copy remains valid until public access is disabled.

The publication is bound to one exact session instance. Resetting, replacing,
forking, or deleting the session does not transfer public access to another
instance. Disabling and enabling again creates a new URL; the old link remains
invalid. The publication record lives with existing session metadata and does
not require a database schema migration. Normal session retention still applies.

Tokens are bound to the Gateway installation identity, not its login token or
password. Rotating Gateway authentication does not break public links. A full
OpenClaw backup preserves both the installation identity and agent session
databases, so links survive a full restore. Restoring only an agent database to
another installation, or replacing the installation identity during repair,
invalidates its existing links; disable and enable public access again to issue
new links.

Behind a login proxy, apply the same narrow `/share/*` routing described in
[Behind a login proxy](/web/urls#behind-a-login-proxy). Keep all other routes protected.
The proxy must overwrite `X-Forwarded-Proto` with the external request scheme;
public session reads require its exact value to be `https`. The viewer and social
card must both be reachable without cookies. OpenClaw
does not change the proxy's access policies automatically.

## Person activity URLs

Open a person's recent sessions with a readable Activity link:

```text
/activity/ada-12345678abcd
/activity/ada-12345678abcd?time=30d&q=release
```

New links use the person's display-name slug and the first 12 lowercase
hexadecimal characters of their profile UUID, with UUID dashes omitted. The
name is decorative: renamed people and stale names still resolve by the id
prefix. A missing name produces a bare-prefix link.

Prefixes from 8 through 32 hexadecimal characters are accepted. If a prefix
matches several profiles, Activity shows an error instead of choosing a person.
Recorded profile identities in retained sessions still resolve if their profile
row is missing; they also participate in ambiguity checks before session filters.
For restricted readers, lookup uses only caller-visible session associations;
hidden draft and incognito sessions cannot affect resolution or ambiguity.
Search, time windows, and pagination do not narrow that visibility scope.
Use a longer prefix, the full 32-character compact UUID, or the full dashed
UUID to select the exact profile. Names never break a tie.

Existing `/activity?person=<profile-id>` links remain accepted and are replaced
with the person path after resolution, without adding browser history. Search
and time filters remain query parameters. Exact UUID bookmarks retain all 32
hexadecimal characters, and unresolved IDs never redirect to a shorter prefix.
Clearing the person filter returns
to `/activity` while retaining those filters. Normal Gateway authentication
and session visibility rules apply to every form.

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

## Beam share URLs

Beam uploads return a dedicated share path such as:

```text
/beam/fix-the-upload-flow-0123456789ab
```

This route is an adapter into the existing read-only Beam session catalog, not
a separate transcript or storage path. It stays in the browser address bar
while the catalog transcript renders. Normal Gateway authentication still
applies; the URL identifies a Beam row but does not authorize access.

Share links open in chat under the default agent. Sidebar and dashboard navigation
keep the explicit catalog-query URL so the selected agent and view are preserved.

New URLs use the same display-name slug as regular session links, followed by
the first 12 lowercase hexadecimal characters of the 32-character Beam id.
The slug is decorative: bare-id links and stale names still resolve by id, and
the browser replaces the slug with the current title without adding history.
If the title produces no slug, the URL contains only the id prefix.
Twelve characters provide 48 bits; against Beam's 500-row retention
bound, the probability that any pair shares that prefix is about 1 in 2.26
billion. Resolution still never assumes uniqueness: exactly one retained row
must match. A missing prefix shows session recovery links, while an
ambiguous prefix shows the matching rows and asks for a longer id. Any longer
lowercase hexadecimal prefix through the full 32-character id is accepted.
Uppercase, non-hexadecimal, shorter, and longer id suffixes, or extra path segments,
are invalid.

With `gateway.controlUi.basePath: "/openclaw"`, use
`/openclaw/beam/fix-the-upload-flow-0123456789ab`.

## Route table

This table lists every Control UI application route. A dash means the route has
no route-specific URL parameters.

| Page                | Canonical path                  | Aliases                   | Parameters or dynamic forms                                       |
| ------------------- | ------------------------------- | ------------------------- | ----------------------------------------------------------------- |
| Chat                | `/chat`                         | -                         | Key-backed session forms above; `?draft=<text>`                   |
| Dashboard           | `/dashboard`                    | -                         | Key-backed session forms above; `?draft=<text>`                   |
| Beam transcript     | `/beam/<title>-<beam-id>`       | `/beam/<beam-id>`         | Optional title slug and 12-32 lowercase hexadecimal id characters |
| Dashboards          | `/dashboards`                   | -                         | -                                                                 |
| Ask OpenClaw        | `/custodian`                    | -                         | `?intent=new-agent`, `?onboarding=1`                              |
| New session         | `/new`                          | -                         | `?agent=<agentId>`, `?catalog=<catalogId>`                        |
| Activity            | `/activity`                     | -                         | `?view=run&run=<run-id>`, `?view=run&execution=<execution-id>`    |
| Person activity     | `/activity/<name>-<profile-id>` | -                         | Optional name slug and 8-32 lowercase hexadecimal id characters   |
| Apps                | `/apps`                         | -                         | -                                                                 |
| Portals             | `/portals`                      | -                         | -                                                                 |
| Agents              | `/settings/agents`              | `/agents`                 | `/settings/agents/<agentId>[/<panel>]`                            |
| Channels            | `/settings/channels`            | `/channels`               | Shared settings parameters below                                  |
| Connection          | `/settings/connection`          | -                         | Shared settings parameters below                                  |
| Legacy General      | `/settings/general`             | `/config`                 | Redirects to Appearance → Language                                |
| Profile             | `/settings/profile`             | `/profile`                | Shared settings parameters below                                  |
| Communications      | `/settings/communications`      | `/communications`         | Shared settings parameters below                                  |
| Appearance          | `/settings/appearance`          | `/appearance`             | Shared settings parameters below                                  |
| Notifications       | `/settings/notifications`       | -                         | Shared settings parameters below                                  |
| Security            | `/settings/security`            | -                         | Shared settings parameters below                                  |
| Secrets             | `/settings/secrets`             | -                         | Shared settings parameters below                                  |
| Advanced            | `/settings/advanced`            | -                         | Shared settings parameters below                                  |
| Approvals           | `/settings/approvals`           | -                         | Shared settings parameters below                                  |
| Automation settings | `/settings/automation`          | `/automation`             | Shared settings parameters below                                  |
| MCP                 | `/settings/mcp`                 | `/mcp`                    | Shared settings parameters below                                  |
| Memory              | `/settings/memory`              | -                         | `/settings/memory/memories\|dreams\|settings`                     |
| Infrastructure      | `/settings/infrastructure`      | `/infrastructure`         | Shared settings parameters below                                  |
| Labs                | `/settings/labs`                | -                         | Shared settings parameters below                                  |
| About               | `/settings/about`               | -                         | Shared settings parameters below                                  |
| AI and agents       | `/settings/ai-agents`           | `/ai-agents`              | Shared settings parameters below                                  |
| Model setup         | `/settings/model-setup`         | `/model-setup`            | `?firstRun=1`                                                     |
| Model providers     | `/settings/model-providers`     | `/model-providers`        | Shared settings parameters below                                  |
| Import memory       | `/memory-import`                | `/settings/memory-import` | -                                                                 |
| Workboard           | `/workboard`                    | -                         | `/workboard/<boardId>`                                            |
| Worktrees           | `/worktrees`                    | `/settings/worktrees`     | -                                                                 |
| Sessions            | `/sessions`                     | `/settings/sessions`      | `?session=<sessionKey>`, `?status=archived\|all`                  |
| Usage               | `/usage`                        | -                         | -                                                                 |
| Debug               | `/debug`                        | -                         | -                                                                 |
| Logs                | `/logs`                         | -                         | -                                                                 |
| Skill Workshop      | `/skills/workshop`              | -                         | -                                                                 |
| Skills              | `/skills`                       | -                         | -                                                                 |
| Plugins             | `/settings/plugins`             | -                         | `/settings/plugins/discover`                                      |
| Automations         | `/automations`                  | `/cron`                   | `?job=<jobId>`, `?job=<jobId>&run=<runId>`                        |
| Tasks               | `/tasks`                        | -                         | -                                                                 |
| Devices             | `/settings/devices`             | `/nodes`                  | Shared settings parameters below                                  |
| Plugin tab host     | `/plugin`                       | -                         | `?plugin=<pluginId>&id=<tabId>`                                   |

Automation links open the exact job independently of the current list filters or
loaded page. Adding `run` opens its run history and highlights the matching loaded
run. A missing job shows the Gateway's lookup error.

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
  never authorizes it; normal Gateway authentication still applies. An approval
  notification uses a scope-relative approval path and may add
  `#gatewayUrl=<encoded-ws-url>` when the owning Gateway has
  `gateway.publicOrigin`. The Control UI strips that fragment before
  authentication and applies the normal remote-Gateway handoff below.

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
- [Beam plugin](/plugins/beam)
- [Dashboard](/web/dashboard)
- [Session dashboards](/web/dashboards)
