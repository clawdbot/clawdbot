---
summary: "Launch self-contained OpenClaw HTML widgets inside Discord Activities"
read_when:
  - Setting up or troubleshooting Discord Activity widgets
title: "Discord Activities"
---

Discord Activities let an agent post an interactive, self-contained HTML widget to the current Discord channel. The message includes an **Open widget** button; clicking it launches the widget inside Discord.

The feature is off by default. OpenClaw registers the Activity HTTP routes, the `show_widget` agent tool, and the launch-button handler only when `channels.discord.activities` is present and a client secret resolves. The deprecated `discord_widget` alias remains available for one release.

## Prerequisites

- an existing [OpenClaw Discord bot](/channels/discord)
- a public HTTPS hostname that reaches the OpenClaw gateway
- permission to configure Activities and OAuth2 for the bot's Discord application

Any HTTPS reverse proxy or tunnel works. A named Cloudflare Tunnel provides a stable hostname without exposing the gateway port directly.

```yaml
# ~/.cloudflared/config.yml
tunnel: openclaw-discord
credentials-file: /home/you/.cloudflared/TUNNEL-ID.json
ingress:
  - hostname: openclaw.example.com
    service: http://127.0.0.1:18789
  - service: http_status:404
```

```bash
cloudflared tunnel login
cloudflared tunnel create openclaw-discord
cloudflared tunnel route dns openclaw-discord openclaw.example.com
cloudflared tunnel run openclaw-discord
```

Keep normal gateway authentication enabled. Only the Activity prefix is public, and the plugin validates OAuth, Activity instance membership, channel binding, sessions, and one-time document capabilities itself.

## Setup

<Steps>
  <Step title="Expose the gateway over HTTPS">
    Start your tunnel or reverse proxy and verify that `https://openclaw.example.com/discord/activity/` reaches the gateway after Activities configuration is added. Replace the example hostname with your own.
  </Step>

  <Step title="Enable Activities in Discord">
    Open the existing bot application in the [Discord Developer Portal](https://discord.com/developers/applications). Open **Activities**, enable Activities, and create a URL mapping:

    - prefix: `ROOT` (`/`)
    - target: `openclaw.example.com/discord/activity`

    The target is the public hostname plus `/discord/activity`, without a trailing slash.

  </Step>

  <Step title="Copy the OAuth2 client secret">
    Open **OAuth2** in the Developer Portal. Discord requires at least one redirect URI, so add a local placeholder such as the loopback address if the application has none yet; the Embedded App SDK handles the Activity return flow. Copy or reset the application client secret. Treat it as a credential: do not paste it into chat, logs, or a committed configuration file.
  </Step>

  <Step title="Configure OpenClaw">
    Add one block to the Discord account that should offer widgets:

    ```json5
    {
      channels: {
        discord: {
          token: "${DISCORD_BOT_TOKEN}",
          activities: {
            clientSecret: "${DISCORD_CLIENT_SECRET}",
            // Optional. Defaults to the bot application ID learned at startup.
            applicationId: "YOUR_DISCORD_APPLICATION_ID",
          },
        },
      },
    }
    ```

    You may omit `clientSecret` from the block when `DISCORD_CLIENT_SECRET` is set. The block itself must remain present to opt in.

    Normal Discord access settings remain separate. For example, `allowFrom` still controls who can DM the agent; it does not control who can open a widget already posted in a channel.

  </Step>

  <Step title="Restart and test">
    Restart the gateway. In a Discord conversation, ask the agent to show an interactive widget. The agent calls `show_widget`; click **Open widget** on the posted message.
  </Step>
</Steps>

## Security model

- OAuth identifies the Discord user before widget metadata is returned.
- Discord's Get Activity Instance API must confirm that the OAuth user is present in the current Activity instance. The instance channel must match the channel where the widget was posted.
- Everyone who Discord permits into that channel can open its widgets. To narrow the audience, use Discord channel permissions. OpenClaw command and DM allowlists do not grant or remove access to already-posted channel content.
- OAuth sessions expire after 15 minutes. Widget document capabilities expire after 60 seconds and work once.
- Widgets expire after seven days, with at most 64 retained per Discord plugin instance.
- Widget HTML is authored by your agent and should be treated as trusted content. Do not embed secrets you would not want a buggy widget to expose.
- The widget can navigate within its own nested frame. The `sandbox="allow-scripts"` iframe blocks top-level navigation, popups, and same-origin access, while its Content Security Policy blocks network connections and external resources. These controls are defense-in-depth, not a security boundary against the agent that authored the widget.
- When Activities is disabled, `/discord/activity` is not registered at all.

The public Activity shell and token-exchange route become reachable through your tunnel when enabled. They do not expose widget HTML without a valid OAuth session and one-time document capability.

## Troubleshooting

### The Activity says “Gateway offline”

- confirm the tunnel is running and routes to the gateway's actual bind port
- confirm the Developer Portal target includes `/discord/activity`
- restart the gateway after changing Discord or OpenClaw configuration
- check gateway logs for the one-line warning about a missing Activities client secret

### Discord opens a blank page or reports `blocked:csp`

- verify the URL mapping uses `ROOT` and does not add a second `/discord/activity` segment
- confirm the shell, `shell.js`, and SDK module all return through the Discord proxy
- inspect gateway logs for requests under `/discord/activity/`

Widget network requests are intentionally blocked. Inline all CSS, JavaScript, images, and data needed by the widget.

### “Widget unavailable”

Launch the button from the channel where the agent posted it. OpenClaw tracks launches server-side when clicked, so a fresh launch record can resolve the exact widget even when Discord omits or mangles the button's custom ID. When neither the custom ID nor a launch record resolves, OpenClaw opens the most recently posted live widget in that channel. Older widgets remain addressable through buttons that preserve their custom ID.

### “You cannot launch Activities in this channel”

Discord does not launch Activities from forum-post threads. OpenClaw can post the widget message and button there, but launch the Activity from a regular text channel instead. This restriction comes from Discord, not OpenClaw.
