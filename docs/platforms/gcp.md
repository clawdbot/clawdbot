---
summary: "Run Clawdbot Gateway 24/7 on a GCP Compute Engine VM (Docker) with durable state"
read_when:
  - You want Clawdbot running 24/7 on GCP
  - You want a production-grade, always-on Gateway on your own VM
  - You want full control over persistence, binaries, and restart behavior
---

# Clawdbot on GCP Compute Engine (Docker, Production VPS Guide)

## Goal

Run a persistent Clawdbot Gateway on a GCP Compute Engine VM using Docker, with durable state, baked-in binaries, and safe restart behavior.

If you want "Clawdbot 24/7 for ~$5-12/mo", this is a reliable setup on Google Cloud.
Pricing varies by machine type and region; pick the smallest VM that fits your workload and scale up if you hit OOMs.

## What are we doing (simple terms)?

- Create a GCP project and enable billing
- Create a Compute Engine VM
- Install Docker (isolated app runtime)
- Start the Clawdbot Gateway in Docker
- Persist `~/.clawdbot` + `~/clawd` on the host (survives restarts/rebuilds)
- Access the Control UI from your laptop via an SSH tunnel

The Gateway can be accessed via:
- SSH port forwarding from your laptop
- Direct port exposure if you manage firewalling and tokens yourself

This guide uses Debian on GCP Compute Engine.
Ubuntu also works; map packages accordingly.
For the generic Docker flow, see [Docker](/install/docker).

---

## Quick path (experienced operators)

1) Create GCP project + enable Compute Engine API
2) Create Compute Engine VM (e2-small, Debian 12, 20GB)
3) SSH into the VM
4) Install Docker
5) Clone Clawdbot repository
6) Create persistent host directories
7) Configure `.env` and `docker-compose.yml`
8) Bake required binaries, build, and launch

---

## What you need

- GCP account (free tier eligible for e2-micro)
- gcloud CLI installed (or use Cloud Console)
- SSH access from your laptop
- Basic comfort with SSH + copy/paste
- ~20-30 minutes
- Docker and Docker Compose
- Model auth credentials
- Optional provider credentials
  - WhatsApp QR
  - Telegram bot token
  - Gmail OAuth

---

## 1) Install gcloud CLI (or use Console)

**Option A: gcloud CLI** (recommended for automation)

Install from https://cloud.google.com/sdk/docs/install

Initialize and authenticate:

```bash
gcloud init
gcloud auth login
```

**Option B: Cloud Console**

All steps can be done via the web UI at https://console.cloud.google.com

---

## 2) Create a GCP project

**CLI:**

```bash
gcloud projects create my-clawdbot-project --name="Clawdbot Gateway"
gcloud config set project my-clawdbot-project
```

Enable billing at https://console.cloud.google.com/billing (required for Compute Engine).

Enable the Compute Engine API:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Go to IAM & Admin > Create Project
2. Name it and create
3. Enable billing for the project
4. Navigate to APIs & Services > Enable APIs > search "Compute Engine API" > Enable

---

## 3) Create the VM

**Machine types:**

| Type | Specs | Cost | Notes |
|------|-------|------|-------|
| e2-small | 2 vCPU, 2GB RAM | ~$12/mo | Recommended |
| e2-micro | 2 vCPU (shared), 1GB RAM | Free tier eligible | May OOM under load |

**CLI:**

```bash
gcloud compute instances create clawdbot-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Go to Compute Engine > VM instances > Create instance
2. Name: `clawdbot-gateway`
3. Region: `us-central1`, Zone: `us-central1-a`
4. Machine type: `e2-small`
5. Boot disk: Debian 12, 20GB
6. Create

---

## 4) SSH into the VM

**CLI:**

```bash
gcloud compute ssh clawdbot-gateway --zone=us-central1-a
```

**Console:**

Click the "SSH" button next to your VM in the Compute Engine dashboard.

Note: SSH key propagation can take 1-2 minutes after VM creation. If connection is refused, wait and retry.

---

## 5) Install Docker (on the VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Log out and back in for the group change to take effect:

```bash
exit
```

Then SSH back in:

```bash
gcloud compute ssh clawdbot-gateway --zone=us-central1-a
```

Verify:

```bash
docker --version
docker compose version
```

---

## 6) Clone the Clawdbot repository

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
```

This guide assumes you will build a custom image to guarantee binary persistence.

---

## 7) Create persistent host directories

Docker containers are ephemeral.
All long-lived state must live on the host.

```bash
mkdir -p ~/.clawdbot
mkdir -p ~/clawd
```

---

## 8) Configure environment variables

Create `.env` in the repository root.

```bash
CLAWDBOT_IMAGE=clawdbot:latest
CLAWDBOT_GATEWAY_TOKEN=change-me-now
CLAWDBOT_GATEWAY_BIND=lan
CLAWDBOT_GATEWAY_PORT=18789

CLAWDBOT_CONFIG_DIR=/home/$USER/.clawdbot
CLAWDBOT_WORKSPACE_DIR=/home/$USER/clawd

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.clawdbot
```

Generate strong secrets:

```bash
openssl rand -hex 32
```

**Do not commit this file.**

---

## 9) Docker Compose configuration

Create or update `docker-compose.yml`.

```yaml
services:
  clawdbot-gateway:
    image: ${CLAWDBOT_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - CLAWDBOT_GATEWAY_BIND=${CLAWDBOT_GATEWAY_BIND}
      - CLAWDBOT_GATEWAY_PORT=${CLAWDBOT_GATEWAY_PORT}
      - CLAWDBOT_GATEWAY_TOKEN=${CLAWDBOT_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${CLAWDBOT_CONFIG_DIR}:/home/node/.clawdbot
      - ${CLAWDBOT_WORKSPACE_DIR}:/home/node/clawd
    ports:
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${CLAWDBOT_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${CLAWDBOT_GATEWAY_BIND}",
        "--port",
        "${CLAWDBOT_GATEWAY_PORT}"
      ]
```

---

## 10) Bake required binaries into the image (critical)

Installing binaries inside a running container is a trap.
Anything installed at runtime will be lost on restart.

All external binaries required by skills must be installed at image build time.

The examples below show three common binaries only:
- `gog` for Gmail access
- `goplaces` for Google Places
- `wacli` for WhatsApp

These are examples, not a complete list.
You may install as many binaries as needed using the same pattern.

If you add new skills later that depend on additional binaries, you must:
1. Update the Dockerfile
2. Rebuild the image
3. Restart the containers

**Example Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 11) Build and launch

```bash
docker compose build
docker compose up -d clawdbot-gateway
```

Verify binaries:

```bash
docker compose exec clawdbot-gateway which gog
docker compose exec clawdbot-gateway which goplaces
docker compose exec clawdbot-gateway which wacli
```

Expected output:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 12) Verify Gateway

```bash
docker compose logs -f clawdbot-gateway
```

Success:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13) Access from your laptop

Create an SSH tunnel to forward the Gateway port:

```bash
gcloud compute ssh clawdbot-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Open in your browser:

`http://127.0.0.1:18789/`

Paste your gateway token.

---

## What persists where (source of truth)

Clawdbot runs in Docker, but Docker is not the source of truth.
All long-lived state must survive restarts, rebuilds, and reboots.

| Component | Location | Persistence mechanism | Notes |
|---|---|---|---|
| Gateway config | `/home/node/.clawdbot/` | Host volume mount | Includes `clawdbot.json`, tokens |
| Model auth profiles | `/home/node/.clawdbot/` | Host volume mount | OAuth tokens, API keys |
| Skill configs | `/home/node/.clawdbot/skills/` | Host volume mount | Skill-level state |
| Agent workspace | `/home/node/clawd/` | Host volume mount | Code and agent artifacts |
| WhatsApp session | `/home/node/.clawdbot/` | Host volume mount | Preserves QR login |
| Gmail keyring | `/home/node/.clawdbot/` | Host volume + password | Requires `GOG_KEYRING_PASSWORD` |
| External binaries | `/usr/local/bin/` | Docker image | Must be baked at build time |
| Node runtime | Container filesystem | Docker image | Rebuilt every image build |
| OS packages | Container filesystem | Docker image | Do not install at runtime |
| Docker container | Ephemeral | Restartable | Safe to destroy |

---

## Updates

To update Clawdbot on the VM:

```bash
cd ~/clawdbot
git pull
docker compose build
docker compose up -d
```

---

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

If using e2-micro and hitting OOM, upgrade to e2-small or e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop clawdbot-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type clawdbot-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start clawdbot-gateway --zone=us-central1-a
```

---

## Service accounts (security best practice)

For personal use, your default user account works fine.

For automation or CI/CD pipelines, create a dedicated service account with minimal permissions:

1. Create a service account:
   ```bash
   gcloud iam service-accounts create clawdbot-deploy \
     --display-name="Clawdbot Deployment"
   ```

2. Grant Compute Instance Admin role (or narrower custom role):
   ```bash
   gcloud projects add-iam-policy-binding my-clawdbot-project \
     --member="serviceAccount:clawdbot-deploy@my-clawdbot-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Avoid using the Owner role for automation. Use the principle of least privilege.

See https://cloud.google.com/iam/docs/understanding-roles for IAM role details.

---

## Next steps

- Set up messaging channels: [Channels](/channels)
- Pair local devices as nodes: [Nodes](/nodes)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
