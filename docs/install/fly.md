---
summary: "Step-by-step Fly.io deployment for OpenClaw with persistent storage and HTTPS"
title: Fly.io
read_when:
  - Deploying OpenClaw on Fly.io
  - Setting up Fly volumes, secrets, and first-run config
---

**Goal:** OpenClaw Gateway running on a [Fly.io](https://fly.io) machine with persistent storage, automatic HTTPS, and Discord/channel access.

## What you need

- [flyctl CLI](https://fly.io/docs/hands-on/install-flyctl/) installed
- Fly.io account (free tier works)
- Model auth: API key for your chosen model provider
- Channel credentials: Discord bot token, Telegram token, etc.

## Beginner quick path

1. Clone repo, customize `fly.toml`
2. Create app + volume, set secrets
3. Deploy with `fly deploy`
4. SSH in to create config, or use the Control UI

<Steps>
  <Step title="Create the Fly app">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw

    # pick your own name
    fly apps create my-openclaw

    # 1GB is usually enough
    fly volumes create openclaw_data --size 1 --region iad
    ```

    Choose a region close to you. Common options: `lhr` (London), `iad` (Virginia), `sjc` (San Jose).

  </Step>

  <Step title="Configure fly.toml">
    Edit `fly.toml` to match your app name and requirements. The repo's tracked `fly.toml` is the public template shown below; `deploy/fly.private.toml` is the hardened, no-public-IP variant (see [Private deployment](#private-deployment-hardened)).

    ```toml
    app = "my-openclaw"  # your app name
    primary_region = "iad"

    [build]
      dockerfile = "Dockerfile"

    [env]
      NODE_ENV = "production"
      OPENCLAW_PREFER_PNPM = "1"
      OPENCLAW_STATE_DIR = "/data"
      NODE_OPTIONS = "--max-old-space-size=1536"

    [processes]
      app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

    [http_service]
      internal_port = 3000
      force_https = true
      auto_stop_machines = false
      auto_start_machines = true
      min_machines_running = 1
      processes = ["app"]

    [[vm]]
      size = "shared-cpu-2x"
      memory = "2048mb"

    [mounts]
      source = "openclaw_data"
      destination = "/data"
    ```

    The OpenClaw Docker image entrypoint is `tini`, running `node openclaw.mjs gateway` by default. Fly `[processes]` replaces the Docker `CMD` (here it runs `node dist/index.js gateway ...` directly, the same compiled entrypoint) without touching `ENTRYPOINT`, so the process still runs under `tini`.

    **Key settings:**

    | Setting                        | Why                                                                         |
    | ------------------------------ | --------------------------------------------------------------------------- |
    | `--bind lan`                   | Binds to `0.0.0.0` so Fly's proxy can reach the gateway                     |
    | `--allow-unconfigured`         | Starts without a config file (you create one after)                        |
    | `internal_port = 3000`         | Must match `--port 3000` (or `OPENCLAW_GATEWAY_PORT`) for Fly health checks |
    | `memory = "2048mb"`            | 512MB is too small; 2GB recommended                                         |
    | `OPENCLAW_STATE_DIR = "/data"` | Persists state on the volume                                                |

  </Step>

  <Step title="Set secrets">
    ```bash
    # required: gateway auth token for non-loopback binding
    fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

    # model provider API keys
    fly secrets set ANTHROPIC_API_KEY=example-anthropic-key-not-real

    # optional: other providers
    fly secrets set OPENAI_API_KEY=example-openai-key-not-real
    fly secrets set GOOGLE_API_KEY=...

    # channel tokens
    fly secrets set DISCORD_BOT_TOKEN=example-discord-bot-token
    ```

    Non-loopback binds (`--bind lan`) require a valid gateway auth path. This example uses `OPENCLAW_GATEWAY_TOKEN`, but `gateway.auth.password` or a correctly configured non-loopback trusted-proxy deployment also satisfy the requirement. See [Secrets management](/gateway/secrets) for the SecretRef contract.

    Treat these tokens like passwords. Prefer env vars/`fly secrets` over the config file for API keys and tokens so secrets stay out of `openclaw.json`.

  </Step>

  <Step title="Deploy">
    ```bash
    fly deploy
    ```

    First deploy builds the Docker image. Verify after deployment:

    ```bash
    fly status
    fly logs
    ```

    Gateway startup logs `gateway ready` once the HTTP/WebSocket listener is up. Fly's own health check watches `internal_port = 3000` per `fly.toml`; the image's Docker `HEALTHCHECK` directive additionally polls `/healthz` on its default port 18789, which is unused here since this deployment overrides the gateway to `--port 3000`.

  </Step>

  <Step title="Create config file">
    SSH into the machine to create a proper config:

    ```bash
    fly ssh console
    ```

    ```bash
    mkdir -p /data
    cat > /data/openclaw.json << 'EOF'
    {
      "agents": {
        "defaults": {
          "model": {
            "primary": "anthropic/claude-opus-4-6",
            "fallbacks": ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4"]
          },
          "maxConcurrent": 4
        },
        "list": [
          {
            "id": "main",
            "default": true
          }
        ]
      },
      "auth": {
        "profiles": {
          "anthropic:default": { "mode": "token", "provider": "anthropic" },
          "openai:default": { "mode": "token", "provider": "openai" }
        }
      },
      "bindings": [
        {
          "agentId": "main",
          "match": { "channel": "discord" }
        }
      ],
      "channels": {
        "discord": {
          "enabled": true,
          "groupPolicy": "allowlist",
          "guilds": {
            "YOUR_GUILD_ID": {
              "channels": { "general": { "allow": true } },
              "requireMention": false
            }
          }
        }
      },
      "gateway": {
        "mode": "local",
        "bind": "auto",
        "controlUi": {
          "allowedOrigins": [
            "https://my-openclaw.fly.dev",
            "http://localhost:3000",
            "http://127.0.0.1:3000"
          ]
        }
      },
      "meta": {}
    }
    EOF
    ```

    With `OPENCLAW_STATE_DIR=/data`, the config path is `/data/openclaw.json`.

    Replace `https://my-openclaw.fly.dev` with your real Fly app origin. Gateway startup seeds local Control UI origins from the runtime `--bind` and `--port` values so first boot can proceed before config exists, but browser access through Fly still needs the exact HTTPS origin listed in `gateway.controlUi.allowedOrigins`.

    The Discord token can come from either:

    - Environment variable `DISCORD_BOT_TOKEN` (recommended for secrets); no need to add it to config, the gateway reads it automatically
    - Config file `channels.discord.token`

    Restart to apply:

    ```bash
    exit
    fly machine restart <machine-id>
    ```

  </Step>

  <Step title="Access the Gateway">
    ### Control UI

    ```bash
    fly open
    ```

    Or visit `https://my-openclaw.fly.dev/`.

    Authenticate with the configured shared secret: the gateway token from `OPENCLAW_GATEWAY_TOKEN`, or your password if you switched to password auth.

    ### Logs

    ```bash
    fly logs              # live logs
    fly logs --no-tail    # recent logs
    ```

    ### SSH console

    ```bash
    fly ssh console
    ```

  </Step>
</Steps>

## Troubleshooting

### "App is not listening on expected address"

The gateway is binding to `127.0.0.1` instead of `0.0.0.0`.

**Fix:** add `--bind lan` to your process command in `fly.toml`.

### Health checks failing / connection refused

Fly cannot reach the gateway on the configured port.

**Fix:** ensure `internal_port` matches the gateway port (`--port 3000` or `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / memory issues

Container keeps restarting or getting killed. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.

**Fix:** increase memory in `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Or update an existing machine:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

512MB is too small. 1GB may work but can OOM under load or with verbose logging. 2GB is recommended.

### Gateway lock issues

Gateway refuses to start with "already running" errors after a container restart.

The runtime lock files live at `<tmpdir>/openclaw-<uid>/gateway.<hash>.lock`
and `gateway.state.<hash>.lock` (Linux:
`/tmp/openclaw-<uid>/gateway.*.lock`), not on the persistent `/data` volume, so
a full container restart normally clears them along with the rest of the
container filesystem. If a lock survives (for example a `fly machine restart`
that preserves the container filesystem) and blocks startup, remove it
manually:

```bash
fly ssh console --command "rm -f /tmp/openclaw-*/gateway.*.lock"
fly machine restart <machine-id>
```

### Config not being read

`--allow-unconfigured` only bypasses the startup guard. It does not create or repair `/data/openclaw.json`, so make sure your real config exists and includes `"gateway": { "mode": "local" }` for a normal local gateway start.

Verify the config exists:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Writing config via SSH

`fly ssh console -C` does not support shell redirection. To write a config file:

```bash
# echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# or sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

`fly sftp` may fail if the file already exists; delete first:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### State not persisting

If you lose auth profiles, channel/provider state, or sessions after a restart, the state dir is writing to the container filesystem instead of the volume.

**Fix:** ensure `OPENCLAW_STATE_DIR=/data` is set in `fly.toml` and redeploy.

## Updating

```bash
git pull
fly deploy
fly status
fly logs
```

`git pull` + `fly deploy` is the supervised path here: it rebuilds the image from the Dockerfile, so the CLI/gateway version, the base OS image, and any Dockerfile changes all update together. `openclaw update` inside the running container is not the same operation, since the image ships as a Docker-built `dist/` tree with no `.git` checkout and no npm-managed global install for it to detect; see [Updating](/install/updating) for that flow on VM-style installs.

### Updating the machine command

To change the startup command without a full redeploy:

```bash
fly machines list
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# or with a memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

A later `fly deploy` resets the machine command back to whatever is in `fly.toml`; re-apply manual changes after redeploying.

## Private deployment (hardened)

By default, Fly allocates public IPs, so your gateway is reachable at `https://your-app.fly.dev` and discoverable by internet scanners (Shodan, Censys, etc.).

Use `deploy/fly.private.toml` for a hardened deployment with **no public IP**: it omits `[http_service]`, so no public ingress is allocated.

### When to use private deployment

- Only outbound calls/messages (no inbound webhooks)
- ngrok or Tailscale tunnels handle any webhook callbacks
- Gateway access is via SSH, proxy, or WireGuard instead of a browser
- The deployment should be hidden from internet scanners

### Setup

```bash
fly deploy -c deploy/fly.private.toml
```

Or convert an existing deployment:

```bash
# list current IPs
fly ips list -a my-openclaw

# release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# switch to the private config so future deploys do not re-allocate public IPs
fly deploy -c deploy/fly.private.toml

# allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

After this, `fly ips list` should show only a `private` type IP:

```text
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Accessing a private deployment

**Option 1: local proxy (simplest)**

```bash
fly proxy 3000:3000 -a my-openclaw
# open http://localhost:3000 in a browser
```

**Option 2: WireGuard VPN**

```bash
fly wireguard create
# import to a WireGuard client, then access via internal IPv6
# example: http://[fdaa:x:x:x:x::x]:3000
```

**Option 3: SSH only**

```bash
fly ssh console -a my-openclaw
```

### Webhooks with private deployment

For webhook callbacks (Twilio, Telnyx, etc.) without public exposure:

1. **ngrok tunnel**: run ngrok inside the container, or as a sidecar
2. **Tailscale Funnel**: expose specific paths via Tailscale
3. **Outbound-only**: some providers (Twilio) work for outbound calls without webhooks

Example voice-call config with ngrok, under `plugins.entries.voice-call.config`:

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
          tunnel: { provider: "ngrok" },
          webhookSecurity: {
            allowedHosts: ["example.ngrok.app"],
          },
        },
      },
    },
  },
}
```

The ngrok tunnel runs inside the container and provides a public webhook URL without exposing the Fly app itself. Set `webhookSecurity.allowedHosts` to the tunnel hostname so forwarded host headers are accepted.

### Security tradeoffs

| Aspect            | Public       | Private    |
| ----------------- | ------------ | ---------- |
| Internet scanners | Discoverable | Hidden     |
| Direct attacks    | Possible     | Blocked    |
| Control UI access | Browser      | Proxy/VPN  |
| Webhook delivery  | Direct       | Via tunnel |

## Notes

- Fly.io uses x86 architecture; the Dockerfile is compatible with both x86 and ARM.
- For WhatsApp/Telegram onboarding, use `fly ssh console`.
- Persistent data lives on the volume at `/data`.
- Signal requires signal-cli (a Java-based CLI) on the image; use a custom image and keep memory at 2GB+.

## Cost

With the recommended config (`shared-cpu-2x`, 2GB RAM), expect roughly $10-15/month depending on usage; the free tier covers some baseline allowance. See [Fly.io pricing](https://fly.io/docs/about/pricing/) for current rates.

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep OpenClaw up to date: [Updating](/install/updating)

## Related

- [Install overview](/install)
- [Hetzner](/install/hetzner)
- [Docker](/install/docker)
- [VPS hosting](/vps)
