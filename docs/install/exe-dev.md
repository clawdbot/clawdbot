---
summary: "Run OpenClaw Gateway on exe.dev (VM + HTTPS proxy) for remote access"
read_when:
  - You want a cheap always-on Linux host for the Gateway
  - You want remote Control UI access without running your own VPS
title: "exe.dev"
---

**Goal:** OpenClaw Gateway running on an [exe.dev](https://exe.dev) VM, reachable at `https://<vm-name>.exe.xyz`.

This guide assumes exe.dev's default **exeuntu** image. Map packages accordingly on other distros.

## What you need

- exe.dev account
- `ssh exe.dev` access to exe.dev VMs (optional, for manual setup)

## Beginner quick path

1. Open [https://exe.new/openclaw](https://exe.new/openclaw)
2. Fill in your auth key/token as needed
3. Click "Agent" next to your VM and wait for Shelley to finish provisioning
4. Open `https://<vm-name>.exe.xyz/` and authenticate with the configured shared secret (token auth by default; password auth also works if you switch `gateway.auth.mode`)
5. Approve pending device pairing requests with `openclaw devices approve <requestId>`

## Automated install with Shelley

Shelley, exe.dev's agent, can install OpenClaw from a prompt:

```text
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw devices approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Manual installation

<Steps>
  <Step title="Create the VM">
    From your device:

    ```bash
    ssh exe.dev new
    ```

    Then connect:

    ```bash
    ssh <vm-name>.exe.xyz
    ```

    <Tip>
    Keep this VM **stateful**. OpenClaw stores `openclaw.json`, per-agent `auth-profiles.json`, sessions, and channel/provider state under `~/.openclaw/`, plus the workspace under `~/.openclaw/workspace/`.
    </Tip>

  </Step>

  <Step title="Install prerequisites (on the VM)">
    ```bash
    sudo apt-get update
    sudo apt-get install -y git curl jq ca-certificates openssl
    ```
  </Step>

  <Step title="Install OpenClaw">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Step>

  <Step title="Configure nginx to proxy to port 8000">
    Edit `/etc/nginx/sites-enabled/default`:

    ```nginx
    server {
        listen 80 default_server;
        listen [::]:80 default_server;
        listen 8000;
        listen [::]:8000;

        server_name _;

        location / {
            proxy_pass http://127.0.0.1:18789;
            proxy_http_version 1.1;

            # WebSocket support
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";

            # Standard proxy headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $remote_addr;
            proxy_set_header X-Forwarded-Proto $scheme;

            # Timeout settings for long-lived connections
            proxy_read_timeout 86400s;
            proxy_send_timeout 86400s;
        }
    }
    ```

    Overwrite forwarding headers instead of preserving client-supplied chains. OpenClaw trusts forwarded IP metadata only from explicitly configured proxies, and append-style `X-Forwarded-For` chains are treated as a hardening risk.

  </Step>

  <Step title="Access OpenClaw and approve devices">
    Open `https://<vm-name>.exe.xyz/` (see the Control UI output from onboarding). If it prompts for auth, paste the configured shared secret from the VM.

    This guide uses token auth by default, so retrieve `gateway.auth.token` with `openclaw config get gateway.auth.token`, or generate a new one with `openclaw doctor --n`. If you switched the gateway to password auth, use `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` instead.

    Approve devices with `openclaw devices list` and `openclaw devices approve <requestId>`. When in doubt, use Shelley from your browser.

  </Step>
</Steps>

## Remote channel setup

For remote hosts, prefer one `config patch` call over many SSH calls to `config set`. Keep real tokens in the VM environment or `~/.openclaw/.env`, and put only SecretRefs in `openclaw.json`. See [Secrets management](/gateway/secrets) for the full SecretRef contract.

On the VM, make the service environment contain the secrets it needs:

```bash
cat >> ~/.openclaw/.env <<'EOF'
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
DISCORD_BOT_TOKEN=...
OPENAI_API_KEY=sk-...
EOF
```

From your local machine, create a patch file and pipe it to the VM:

```json5
// openclaw.remote.patch.json5
{
  secrets: {
    providers: {
      default: { source: "env" },
    },
  },
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      botToken: { source: "env", provider: "default", id: "SLACK_BOT_TOKEN" },
      appToken: { source: "env", provider: "default", id: "SLACK_APP_TOKEN" },
      groupPolicy: "open",
      requireMention: false,
    },
    discord: {
      enabled: true,
      token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
      dmPolicy: "disabled",
      dm: { enabled: false },
      groupPolicy: "allowlist",
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      models: {
        "openai/gpt-5.6-sol": { params: { fastMode: true } },
      },
    },
  },
}
```

```bash
ssh <vm-name>.exe.xyz 'openclaw config patch --stdin --dry-run' < ./openclaw.remote.patch.json5
ssh <vm-name>.exe.xyz 'openclaw config patch --stdin' < ./openclaw.remote.patch.json5
ssh <vm-name>.exe.xyz 'openclaw gateway restart && openclaw health'
```

Use `--replace-path` when a nested allowlist should become exactly the patch value, for example replacing a Discord channel allowlist:

```bash
ssh <vm-name>.exe.xyz 'openclaw config patch --stdin --replace-path "channels.discord.guilds[\"123\"].channels"' < ./discord.patch.json5
```

See [Discord](/channels/discord) and [Slack](/channels/slack) for full channel config reference.

## Remote access

exe.dev handles authentication for remote access. By default, HTTP traffic from port 8000 is forwarded to `https://<vm-name>.exe.xyz` with email auth.

## Updating

```bash
openclaw update
```

See [Updating](/install/updating) for channel switches and manual recovery.

## Related

- [Remote gateway](/gateway/remote)
- [Install overview](/install)
