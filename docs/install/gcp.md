---
summary: "Run OpenClaw Gateway 24/7 on a GCP Compute Engine VM with Docker"
doc-schema-version: 1
read_when:
  - You want OpenClaw running 24/7 on GCP
  - You want a persistent Gateway on a Compute Engine VM
  - You need GCP provisioning, firewall, or SSH tunnel guidance
title: "GCP"
---

Run a persistent OpenClaw Gateway on a Debian Compute Engine VM. This page
covers GCP provisioning, network access, and machine operations; the shared
[Docker VM runtime](/install/docker-vm-runtime) page owns container setup,
persistence, custom binaries, verification, and updates.

Pricing varies by machine type and region. Use at least 6 GB RAM for a source
image build. On a smaller machine, use the official pre-built image described
in [Docker VM runtime](/install/docker-vm-runtime).

## What you need

- A GCP project with billing enabled
- The `gcloud` CLI or the [Cloud Console](https://console.cloud.google.com)
- SSH access from your laptop
- Model and optional channel credentials
- About 20 minutes

## Provision the VM

<Steps>
  <Step title="Initialize gcloud">
    Install the CLI from
    [cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install),
    then authenticate:

    ```bash
    gcloud init
    gcloud auth login
    ```

    You can perform the same steps in the Cloud Console.

  </Step>

  <Step title="Create the project">
    ```bash
    gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
    gcloud config set project my-openclaw-project
    gcloud services enable compute.googleapis.com
    ```

    Enable billing in the
    [Billing console](https://console.cloud.google.com/billing). Compute Engine
    will not start without it.

  </Step>

  <Step title="Choose a machine">
    | Type          | Specs                   | Notes                                  |
    | ------------- | ----------------------- | -------------------------------------- |
    | e2-standard-2 | 2 vCPU, 8 GB RAM        | Recommended for source image builds    |
    | e2-medium     | 2 vCPU, 4 GB RAM        | Use the official pre-built image       |
    | e2-small      | 2 vCPU, 2 GB RAM        | Use the official pre-built image       |

    Create a Debian 12 VM:

    ```bash
    gcloud compute instances create openclaw-gateway \
      --zone=us-central1-a \
      --machine-type=e2-standard-2 \
      --boot-disk-size=20GB \
      --image-family=debian-12 \
      --image-project=debian-cloud
    ```

  </Step>

  <Step title="Review firewall access">
    Keep TCP 18789 closed to the public Internet. The SSH tunnel below needs
    only SSH access to the VM:

    ```bash
    gcloud compute firewall-rules list \
      --format='table(name,network,direction,sourceRanges.list():label=SOURCE_RANGES,allowed[].map().firewall_rule().list():label=ALLOW)'
    ```

    Restrict SSH source ranges to your administrative network when possible.
    If you intentionally expose the Gateway through a reverse proxy or tailnet,
    follow [Gateway security](/gateway/security) rather than adding a broad
    `0.0.0.0/0` rule for port 18789.

  </Step>

  <Step title="Connect over SSH">
    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    ```

    SSH key propagation can take a minute or two after VM creation. Wait and
    retry if the first connection is refused.

  </Step>

  <Step title="Install Docker">
    On the VM:

    ```bash
    sudo apt-get update
    sudo apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker "$USER"
    exit
    ```

    Reconnect so the group change takes effect, then verify the installation:

    ```bash
    gcloud compute ssh openclaw-gateway --zone=us-central1-a
    docker --version
    docker compose version
    ```

  </Step>
</Steps>

## Configure the Docker runtime

On the VM, follow [Docker VM runtime](/install/docker-vm-runtime) from
**Before you begin** through **Verify and administer the Gateway**. The
maintained setup script uses these GCP host paths by default:

```bash
export OPENCLAW_CONFIG_DIR="$HOME/.openclaw"
export OPENCLAW_WORKSPACE_DIR="$HOME/.openclaw/workspace"
export OPENCLAW_AUTH_PROFILE_SECRET_DIR="$HOME/.openclaw-auth-profile-secrets"
```

If a source build ends with `Killed`, `ResourceExhausted`, or exit code 137,
resize the VM before retrying.

## Access the Control UI

From your laptop, open an SSH tunnel and leave it running:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Open `http://127.0.0.1:18789/`. Paste the Gateway token from the VM's `.env`
when prompted. To reprint the dashboard URL or approve a browser device, run on
the VM:

```bash
cd openclaw
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

## Troubleshooting

### SSH connection refused

Wait one or two minutes for SSH key propagation, then retry. Check the VM is
running and that an ingress firewall rule allows TCP 22 from your current
network.

### OS Login issues

```bash
gcloud compute os-login describe-profile
```

Ensure your account has Compute OS Login or Compute OS Admin Login permission.

### Resize after an out-of-memory build

```bash
gcloud compute instances stop openclaw-gateway --zone=us-central1-a
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-medium
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

## Use a deployment service account

For personal setup, your user account is enough. Automation should use a
dedicated service account with the narrowest role that works:

```bash
gcloud iam service-accounts create openclaw-deploy \
  --display-name="OpenClaw Deployment"

gcloud projects add-iam-policy-binding my-openclaw-project \
  --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1"
```

Avoid the Owner role. See
[Understanding roles](https://cloud.google.com/iam/docs/understanding-roles).

## Next steps

- [Channels](/channels)
- [Nodes](/nodes)
- [Gateway configuration](/gateway/configuration)
- [Docker VM Runtime](/install/docker-vm-runtime#update-openclaw)

## Related

- [Install overview](/install)
- [Docker VM Runtime](/install/docker-vm-runtime)
- [VPS hosting](/vps)
