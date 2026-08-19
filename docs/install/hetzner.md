---
summary: "Run OpenClaw Gateway 24/7 on a Hetzner VPS with Docker"
doc-schema-version: 1
read_when:
  - You want OpenClaw running 24/7 on a Hetzner VPS
  - You need Hetzner provisioning, firewall, or SSH tunnel guidance
  - You want a persistent Docker Gateway on a cloud VM
title: "Hetzner"
---

Run a persistent OpenClaw Gateway on a Debian or Ubuntu Hetzner VPS. This page
covers Hetzner provisioning, host security, and access; the shared
[Docker VM runtime](/install/docker-vm-runtime) page owns container setup,
persistence, custom binaries, verification, and updates.

Treat the VPS as stateful infrastructure. Keep personal browser, Apple, Google,
and password-manager profiles off a company-shared runtime. If users do not
share one trust boundary, split them across Gateways, hosts, or OS users. See
[Gateway security](/gateway/security) and [VPS hosting](/vps).

## What you need

- A Hetzner VPS with root access
- SSH access from your laptop
- A Hetzner Cloud Firewall or host firewall
- Model and optional channel credentials
- About 20 minutes

## Provision and secure the VPS

<Steps>
  <Step title="Create the server">
    In Hetzner Cloud, create a Debian or Ubuntu server with at least 2 GB RAM
    for a source image build. Add your SSH key during provisioning.

    Connect as root:

    ```bash
    ssh root@<vps-ip>
    ```

  </Step>

  <Step title="Restrict inbound traffic">
    Attach a Hetzner Cloud Firewall that allows TCP 22 from your administrative
    network. Do not add a public inbound rule for TCP 18789; the tunnel below
    reaches that port through SSH.

    If you also use UFW on the host, allow SSH before enabling it:

    ```bash
    apt-get update
    apt-get install -y ufw
    ufw allow OpenSSH
    ufw enable
    ufw status verbose
    ```

    If you intentionally publish the Gateway through a reverse proxy or
    tailnet, follow [Gateway security](/gateway/security) instead of opening the
    container port directly to `0.0.0.0/0`.

  </Step>

  <Step title="Install Docker">
    ```bash
    apt-get update
    apt-get install -y git curl ca-certificates
    curl -fsSL https://get.docker.com | sh
    docker --version
    docker compose version
    ```

  </Step>
</Steps>

## Configure the Docker runtime

On the VPS, follow [Docker VM runtime](/install/docker-vm-runtime) from
**Before you begin** through **Verify and administer the Gateway**. The
maintained setup script uses these root-owned host paths by default:

```bash
export OPENCLAW_CONFIG_DIR="$HOME/.openclaw"
export OPENCLAW_WORKSPACE_DIR="$HOME/.openclaw/workspace"
export OPENCLAW_AUTH_PROFILE_SECRET_DIR="$HOME/.openclaw-auth-profile-secrets"
```

If a source build ends with `Killed` or exit code 137, resize the server before
retrying. See the shared guide for binary baking, the complete persistence map,
and the update command.

## Access the Control UI

First confirm the VPS SSH daemon allows local port forwarding. In
`/etc/ssh/sshd_config`, use:

```text
AllowTcpForwarding local
```

`local` permits `ssh -L` from your laptop while blocking remote forwards from
the server. After changing it, validate and restart SSH:

```bash
sshd -t
systemctl restart ssh
```

From your laptop, open the tunnel and leave it running:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@<vps-ip>
```

Open `http://127.0.0.1:18789/` and paste the Gateway token from the VPS `.env`.
To reprint the dashboard URL or approve a browser device, run on the VPS:

```bash
cd openclaw
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

If the tunnel fails with `administratively prohibited`, recheck
`AllowTcpForwarding` and the SSH service configuration. A cloud firewall only
needs to admit SSH; it does not need to admit port 18789.

## Infrastructure as code

For teams that prefer Terraform, community-maintained projects provide remote
state, cloud-init provisioning, deployment and backup scripts, firewall
hardening, and SSH tunnel setup:

- [openclaw-terraform-hetzner](https://github.com/andreesg/openclaw-terraform-hetzner)
- [openclaw-docker-config](https://github.com/andreesg/openclaw-docker-config)

<Note>
These repositories are community-maintained. Report issues and contribute in
their respective repositories.
</Note>

## Next steps

- [Channels](/channels)
- [Gateway configuration](/gateway/configuration)
- [Updating](/install/docker-vm-runtime#update-openclaw)

## Related

- [Install overview](/install)
- [Docker VM Runtime](/install/docker-vm-runtime)
- [Docker](/install/docker)
- [VPS hosting](/vps)
