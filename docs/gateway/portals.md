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

The agent opens a portal for the application's port, then starts the development server with a background `exec` call. OpenClaw passes the selected port as `PORT` and the portal's public base URL as `PUBLIC_URL`.

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

## Security model

Each portal uses a separate origin on its own port and binds to the same interfaces as the Gateway. Access requires the token in the portal URL. On the first request, the proxy stores that token in an HttpOnly cookie and removes it from subsequent upstream requests.

Portals proxy only the selected local development server. They never serve Gateway data, and every portal ends when the Gateway restarts.

## Limitations

- The development server must run on the Gateway host. Remote worker support is planned.
- A reverse proxy, Serve route, or funnel in front of the Gateway does not automatically expose portal ports.

## Troubleshooting

### The portal shows a 502 waiting page

The proxy is ready, but the application is not listening on the selected port. The page retries automatically. Check the background process and confirm that the server honors `PORT`.

### Close a portal

Ask the agent to "close the portal," or use the close button on the **Control UI → Portals** page.
