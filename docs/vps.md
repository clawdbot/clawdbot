---
summary: "VPS hosting hub for Clawdbot (Oracle/Fly/Hetzner/GCP/exe.dev)"
read_when:
  - You want to run the Gateway in the cloud
  - You need a quick map of VPS/hosting guides
---
# VPS hosting

This hub links to the supported VPS/hosting guides and explains how cloud
deployments work at a high level.

## Pick a provider

- **Railway** (one‑click + browser setup): [Railway](/railway)
- **Northflank** (one‑click + browser setup): [Northflank](/northflank)
- **Oracle Cloud (Always Free)**: [Oracle](/platforms/oracle) — $0/month (Always Free, ARM; capacity/signup can be finicky)
- **Fly.io**: [Fly.io](/platforms/fly)
- **Hetzner (Docker)**: [Hetzner](/platforms/hetzner)
- **GCP (Compute Engine)**: [GCP](/platforms/gcp)
- **exe.dev** (VM + HTTPS proxy): [exe.dev](/platforms/exe-dev)
- **AWS (EC2/Lightsail/free tier)**: works well too. Video guide:
  https://x.com/techfrenAJ/status/2014934471095812547

## How cloud setups work

- The **Gateway runs on the VPS** and owns state + workspace.
- You connect from your laptop/phone via the **Control UI** or **Tailscale/SSH**.
- Treat the VPS as the source of truth and **back up** the state + workspace.
- Secure default: keep the Gateway on loopback and access it via SSH tunnel or Tailscale Serve.
  If you bind to `lan`/`tailnet`, require `gateway.auth.token` or `gateway.auth.password`.

Remote access: [Gateway remote](/gateway/remote)  
Platforms hub: [Platforms](/platforms)

## Using nodes with a VPS

You can keep the Gateway in the cloud and pair **nodes** on your local devices
(Mac/iOS/Android/headless). Nodes provide local screen/camera/canvas and `system.run`
capabilities while the Gateway stays in the cloud.

Docs: [Nodes](/nodes), [Nodes CLI](/cli/nodes)
