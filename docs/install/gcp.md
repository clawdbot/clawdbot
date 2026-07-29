---
summary: "Run OpenClaw Gateway 24/7 on a GCP Compute Engine VM (Docker) with durable state"
read_when:
  - You want OpenClaw running 24/7 on GCP
  - You want a production-grade, always-on Gateway on your own VM
  - You want full control over persistence, binaries, and restart behavior
title: "GCP"
---

Run a persistent OpenClaw Gateway on a GCP Compute Engine VM using Docker, with durable state, baked-in binaries, and safe restart behavior.

Pricing varies by machine type and region; pick the smallest VM that fits your workload and scale up if you hit OOMs.

The Gateway can be accessed via SSH port forwarding from your laptop, or via direct port exposure if you manage firewalling and tokens yourself.

This guide uses Debian on GCP Compute Engine. Ubuntu also works; map packages accordingly. For the generic Docker flow, see [Docker](/install/docker).

## What you need

- GCP account (`e2-micro` is free-tier eligible)
- `gcloud` CLI, or the [Cloud Console](https://console.cloud.google.com)
- SSH access from your laptop
- Docker and Docker Compose
- Model auth credentials
- Optional provider credentials (WhatsApp QR, Telegram bot token, Gmail OAuth)
- ~20-30 minutes

## Quick path

1. Create a GCP project, enable billing and the Compute Engine API
2. Create a Compute Engine VM (`e2-small`, Debian 12, 20GB)
3. SSH into the VM, install Docker
4. Clone the OpenClaw repository
5. Create persistent host directories
6. Configure `.env` and `docker-compose.yml`
7. Bake required binaries, build, and launch

<Steps>
  <Step title="Install gcloud CLI (or use Console)">
    Install from [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install), then:

    ```bash
    gcloud init
    gcloud auth login
    ```

    Or do every step below through the [Cloud Console](https://console.cloud.google.com) web UI instead.

  </Step>

  <Step title="Create a GCP project">
    ```bash
    gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
    gcloud config set project my-openclaw-project
    gcloud services enable compute.googleapis.com
    ```

    Enable billing at [console.cloud.google.com/billing](https://console.cloud.google.com/billing) (required for Compute Engine).

    Console equivalent: IAM & Admin > Create Project, enable billing, then APIs & Services > Enable APIs > "Compute Engine API" > Enable.

  </Step>

  <Step title="Create the VM">
    | Type      | Specs                    | Cost               | Notes                                        |
    | --------- | ------------------------ | ------------------ | --------------------------------------------- |
    | e2-medium | 2 vCPU, 4GB RAM          | ~$25/mo            | Most reliable for local Docker builds         |
    | e2-small  | 2 vCPU, 2GB RAM          | ~$12/mo            | Minimum recommended for a Docker build        |
    | e2-micro  | 2 vCPU (shared), 1GB RAM | Free tier eligible | Often fails with Docker build OOM (exit 137)  |

    ```bash
    gcloud compute instances create openclaw-gateway \
      --zone=us-central1-a \
      --machine-type=e2-small \
      --boot-disk-size=20GB \
      --image-family=debian-12 \
      --image-project=debian-cloud
    ```

  </Step>

  <Step title="SSH into the VM">
    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    Console: click "SSH" next to the VM in the Compute Engine dashboard.

    SSH key propagation can take 1-2 minutes after VM creation; wait and retry if connection is refused.

  </Step>

  <Step title="Install Docker (on the VM)">
    ```bash
    sudo apt-get update
    sudo apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    ```

    Log out and back in for the group change to take effect, then SSH back in:

    ```bash
    exit
    ```

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    Verify:

    ```bash
    docker --version
    docker compose version
    ```

  </Step>

  <Step title="Clone the OpenClaw repository">
    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw
    ```

    This guide builds a custom image so any binaries you bake in survive restarts.

  </Step>

  <Step title="Create persistent host directories">
    Docker containers are ephemeral; all long-lived state must live on the host.

    ```bash
    mkdir -p ~/.openclaw
    mkdir -p ~/.openclaw/workspace
    ```

  </Step>

  <Step title="Configure environment variables">
    Create `.env` in the repository root:

    ```bash
    OPENCLAW_IMAGE=openclaw:latest
    OPENCLAW_GATEWAY_TOKEN=
    OPENCLAW_GATEWAY_BIND=lan
    OPENCLAW_GATEWAY_PORT=18789

    OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
    OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

    GOG_KEYRING_PASSWORD=
    XDG_CONFIG_HOME=/home/node/.openclaw
    ```

    Set `OPENCLAW_GATEWAY_TOKEN` to manage the stable gateway token through
    `.env`; otherwise configure `gateway.auth.token` before relying on clients
    across restarts. If neither is set, OpenClaw uses a runtime-only token for
    that startup. Generate a keyring password for `GOG_KEYRING_PASSWORD`:

    ```bash
    openssl rand -hex 32
    ```

    **Do not commit this file.** It holds container/runtime env such as
    `OPENCLAW_GATEWAY_TOKEN`. Stored provider OAuth/API-key auth lives in the
    mounted `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`.

  </Step>

  <Step title="Docker Compose configuration">
    Create or update `docker-compose.yml`:

    ```yaml
    services:
      openclaw-gateway:
        image: ${OPENCLAW_IMAGE}
        build: .
        restart: unless-stopped
        env_file:
          - .env
        environment:
          - HOME=/home/node
          - NODE_ENV=production
          - TERM=xterm-256color
          - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
          - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
          - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
          - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
          - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
          - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
        volumes:
          - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
          - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
        ports:
          # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
          # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
          - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"
        command:
          [
            "node",
            "dist/index.js",
            "gateway",
            "--bind",
            "${OPENCLAW_GATEWAY_BIND}",
            "--port",
            "${OPENCLAW_GATEWAY_PORT}",
            "--allow-unconfigured",
          ]
    ```

    `--allow-unconfigured` is only for bootstrap convenience, not a substitute for real gateway configuration. Still set auth (`gateway.auth.token` or password) and a safe bind mode for your deployment.

  </Step>

  <Step title="Shared Docker VM runtime steps">
    Follow the shared runtime guide for the common Docker host flow:

    - [Bake required binaries into the image](/install/docker-vm-runtime#bake-required-binaries-into-the-image)
    - [Build and launch](/install/docker-vm-runtime#build-and-launch)
    - [What persists where](/install/docker-vm-runtime#what-persists-where)
    - [Updates](/install/docker-vm-runtime#updates)

  </Step>

  <Step title="GCP-specific launch notes">
    If the build fails with `Killed` or `exit code 137` during `pnpm install --frozen-lockfile`, the VM is out of memory. Use `e2-small` at minimum, or `e2-medium` for more reliable first builds.

    When binding to LAN (`OPENCLAW_GATEWAY_BIND=lan`), configure a trusted browser origin before continuing:

    ```bash
    docker compose run --rm openclaw-cli config set gateway.controlUi.allowedOrigins '["http://127.0.0.1:18789"]' --strict-json
    ```

    Replace `18789` with your configured port if you changed it.

  </Step>

  <Step title="Access from your laptop">
    Create an SSH tunnel to forward the Gateway port:

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
    ```

    Open `http://127.0.0.1:18789/` in your browser.

    Reprint a clean dashboard link:

    ```bash
    docker compose run --rm openclaw-cli dashboard --no-open
    ```

    If the UI prompts for shared-secret auth, paste the configured token or
    password into Control UI settings (this Docker flow writes a token by
    default; use your configured password instead if you switched to password
    auth).

    If Control UI shows `unauthorized` or `disconnected (1008): pairing required`, approve the browser device:

    ```bash
    docker compose run --rm openclaw-cli devices list
    docker compose run --rm openclaw-cli devices approve <requestId>
    ```

    See [Docker VM Runtime](/install/docker-vm-runtime#what-persists-where) for the shared persistence map and [update flow](/install/docker-vm-runtime#updates).

  </Step>
</Steps>

## Troubleshooting

**SSH connection refused**

SSH key propagation can take 1-2 minutes after VM creation. Wait and retry.

**OS Login issues**

Check your OS Login profile:

```bash
gcloud compute os-login describe-profile
```

Ensure your account has the required IAM permissions (Compute OS Login or Compute OS Admin Login).

**Out of memory (OOM)**

If the Docker build fails with `Killed` and `exit code 137`, the VM was OOM-killed:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

## Service accounts (security best practice)

For personal use, your default user account works fine. For automation or CI/CD, create a dedicated service account with minimal permissions:

```bash
gcloud iam service-accounts create openclaw-deploy \
  --display-name="OpenClaw Deployment"

gcloud projects add-iam-policy-binding my-openclaw-project \
  --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"
```

Avoid the Owner role for automation; use the narrowest role that works. See [Understanding roles](https://cloud.google.com/iam/docs/understanding-roles).

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)

## Related

- [Install overview](/install)
- [Azure](/install/azure)
- [VPS hosting](/vps)
