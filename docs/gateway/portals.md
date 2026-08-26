---
title: "Portals"
summary: "Expose agent-run development servers to the operator through the Gateway"
read_when:
  - Showing a development server in the Control UI
  - Declaring workspace development servers for an agent
  - Troubleshooting portal access or live reload
---

Portals expose a development server running on the Gateway host to the operator's browser. They proxy HTTP and WebSockets for live reload and appear in **Control UI → Portals**.

## Quick start

Ask the agent to open a portal:

- "Show me in a portal."
- "Start the app in a portal."

The agent opens a portal for the application's port, then starts the development server with a background `exec` call. Opening a portal only creates the proxy listener; it does not inject environment variables into your server. The agent sets `PORT` (the port it opened) and `PUBLIC_URL` (the portal's public base URL) in that `exec` command's own environment, so the app binds the expected port and generates correct absolute URLs.

## Declare development servers

Optionally commit `.openclaw/portals.json` to the workspace repository so the agent can discover the available development servers:

```json
{
  "portals": [
    {
      "name": "web",
      "command": "pnpm dev",
      "cwd": ".",
      "port": 3000,
      "title": "App",
      "description": "Use the seeded test account."
    }
  ]
}
```

The Gateway never executes these commands automatically. The agent reads the file and decides when to run a declared server.

| Field         | Required | Description                                        |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | Stable name the agent uses to identify the server. |
| `command`     | yes      | Command the agent starts with background `exec`.   |
| `port`        | yes      | Local TCP port the application listens on.         |
| `cwd`         | no       | Working directory relative to the workspace root.  |
| `title`       | no       | Display title shown on the Portals page.           |
| `description` | no       | Operator guidance shown beside the portal.         |
| `path`        | no       | Initial URL path. It must begin with `/`.          |

## Application contract

The application must honor `PORT`. Use `PUBLIC_URL` when it needs to generate absolute URLs.

The proxy rewrites `Host` to the local target, so typical development servers such as Vite and Next.js need no additional configuration. WebSockets and hot module replacement are proxied through the same portal.

## Availability and configuration

Portals add no dedicated configuration key. The `portal` tool follows ordinary tool policy, described in [Tools configuration](/gateway/config-tools).

Out of the box:

- `portal` belongs to `group:ui` and the `coding` profile, so coding agents have it while `messaging` and `minimal` agents do not.
- Sandboxed sessions never receive it, because opening a portal starts a listener on the Gateway host.
- It is blocked for HTTP `POST /tools/invoke` and restricted to the session owner, the same treatment `terminal` gets.

To turn portals off everywhere, deny the tool in the global policy:

```json5
{
  tools: { deny: ["portal"] },
}
```

To turn them off for a single agent, leaving the others unchanged:

```json5
{
  agents: { entries: { "<agentId>": { tools: { deny: ["portal"] } } } },
}
```

`tools.profile`, `tools.allow`, `byProvider`, and `toolsBySender` apply to `portal` as they do to any other tool, so portals can also be limited to specific providers, models, or senders without a portal-specific setting.

One consequence worth planning for: portal listeners bind the same interfaces as the Gateway. A Gateway bound to a LAN or tailnet address publishes its portal listener ports on that network too. Reaching one still requires the portal token, but deny the tool when the Gateway host must not offer operator-reachable application ports at all.

## Security model

Each portal uses a separate origin on its own port and binds to the same interfaces as the Gateway. Access requires the token in the portal URL. On the first request, the proxy stores that token in an HttpOnly cookie and removes it from subsequent upstream requests. The proxy validates this cookie itself and never forwards it to the application.

Browser cookies are hostname-scoped rather than port-scoped, so the proxy gives each portal instance a random `oc_portal_<instance>_` cookie-name prefix. Requests forward only cookies with the current portal's prefix and strip it before reaching the application; Gateway cookies, unprefixed cookies, and cookies from sibling or closed portals are dropped. Application `Set-Cookie` responses receive the prefix, and any `Domain` attribute is removed so the cookie stays host-only.

Portals proxy only the selected local development server. They never serve Gateway data, and every portal ends when the Gateway restarts.

## Limitations

- The development server must run on the Gateway host. Remote worker support is planned.
- A proxy or tunnel in front of the Gateway does not automatically expose portal listener ports. The Control UI detects this and shows a reachable URL with retry guidance instead of mounting a dead iframe.
- The prefix isolates cookies forwarded to each target; it does not create separate browser cookie jars. Browser-side code can see non-`HttpOnly` cookies for sibling portals on the same hostname through `document.cookie`. Use `HttpOnly` for sensitive application cookies. Applications that manage cookies in browser code must account for the prefix; unprefixed cookies written directly by browser code are not forwarded to the target.

## Troubleshooting

### The portal shows a 502 waiting page

The proxy is ready, but the application is not listening on the selected port. The page retries automatically. Check the background process and confirm that the server honors `PORT`.

### The portal is not reachable from this browser

The Control UI could reach the Gateway but could not reach the portal's separate listener port. This commonly happens when a proxy or tunnel exposes only the main Gateway port. Open the displayed portal URL from a browser on the Gateway host, or expose that portal listener port through the same network path, then select **Retry**.

### Close a portal

Ask the agent to "close the portal," or use the close button on the **Control UI → Portals** page.
