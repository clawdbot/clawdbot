---
summary: "Deploy OpenClaw on Render with Infrastructure-as-Code"
read_when:
  - Deploying OpenClaw to Render
  - You want a declarative cloud deploy with Render Blueprints
title: "Render"
---

Deploy OpenClaw on [Render](https://render.com) using the repo's `render.yaml` Blueprint. It declares the service, disk, and environment variables in one file.

## Prerequisites

- A [Render account](https://render.com) (free tier available)
- An API key from your preferred [model provider](/providers)

## Deploy

[Deploy to Render](https://render.com/deploy?repo=https://github.com/openclaw/openclaw)

This creates a Render service from `render.yaml`, builds the Docker image, and deploys it. Your service URL follows the pattern `https://<service-name>.onrender.com`.

## The Blueprint

```yaml
services:
  - type: web
    name: openclaw
    runtime: docker
    plan: starter
    healthCheckPath: /health
    envVars:
      - key: OPENCLAW_GATEWAY_PORT
        value: "8080"
      - key: OPENCLAW_STATE_DIR
        value: /data/.openclaw
      - key: OPENCLAW_WORKSPACE_DIR
        value: /data/workspace
      - key: OPENCLAW_GATEWAY_TOKEN
        generateValue: true # auto-generates a secure token
    disk:
      name: openclaw-data
      mountPath: /data
      sizeGB: 1
```

| Feature               | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `runtime: docker`     | Builds from the repo's Dockerfile                          |
| `healthCheckPath`     | Render monitors `/health` and restarts unhealthy instances |
| `generateValue: true` | Auto-generates a cryptographically secure value            |
| `disk`                | Persistent storage that survives redeploys                 |

## Choosing a plan

| Plan      | Spin-down         | Disk          | Best for                      |
| --------- | ----------------- | ------------- | ----------------------------- |
| Free      | After 15 min idle | Not available | Testing, demos                |
| Starter   | Never             | 1GB+          | Personal use, small teams     |
| Standard+ | Never             | 1GB+          | Production, multiple channels |

The Blueprint defaults to `starter`. To use the free tier, change `plan: free` in your fork's `render.yaml` — note that with no persistent disk, OpenClaw state resets on each deploy.

## After deployment

### Access the Control UI

The web dashboard is available at `https://<your-service>.onrender.com/`. Connect using the shared secret: the auto-generated `OPENCLAW_GATEWAY_TOKEN` (find it in **Dashboard → your service → Environment**), or your password if you switched to password auth.

### Logs

**Dashboard → your service → Logs** shows build logs (Docker image creation), deploy logs (service startup), and runtime logs (application output).

### Shell access

**Dashboard → your service → Shell** opens a shell session. The persistent disk is mounted at `/data`.

### Environment variables

Edit variables in **Dashboard → your service → Environment**. Changes trigger an automatic redeploy.

### Auto-deploy

Render redeploys automatically when the connected repo's branch gets a new commit. If you deployed straight from `openclaw/openclaw` instead of your own fork, you have no push access to trigger that, so update by running a manual Blueprint sync from the Dashboard, or point the service at your own fork.

## Custom domain

1. **Dashboard → your service → Settings → Custom Domains**
2. Add your domain
3. Configure DNS as instructed (CNAME to `*.onrender.com`)
4. Render provisions a TLS certificate automatically

## Scaling

- **Vertical**: change the plan for more CPU/RAM. Usually sufficient for OpenClaw.
- **Horizontal**: increase instance count (Standard plan and above). Requires sticky sessions or external state management since OpenClaw keeps runtime state on the local disk.

## Backups and migration

From the Render Dashboard shell, export state, config, auth profiles, and workspace at any time:

```bash
openclaw backup create
```

This creates a portable backup archive. See [Backup](/cli/backup).

## Troubleshooting

### Service will not start

Check the deploy logs in the Render Dashboard. Common issues:

- Missing `OPENCLAW_GATEWAY_TOKEN` — verify it is set in **Dashboard → Environment**
- Port mismatch — ensure `OPENCLAW_GATEWAY_PORT=8080` so the gateway binds to the port Render expects

### Slow cold starts (free tier)

Free tier services spin down after 15 minutes of inactivity; the first request after spin-down takes a few seconds while the container starts. Upgrade to Starter for always-on.

### Data loss after redeploy

Happens on the free tier (no persistent disk). Upgrade to a paid plan, or regularly export a backup with `openclaw backup create` from the Render shell.

### Health check failures

If builds succeed but deploys fail, the service may be taking too long to start or `/health` may not be reachable. Check:

- Build logs for errors
- Whether the container runs locally with `docker build && docker run`

## Next steps

- Set up messaging channels: [Channels](/channels)
- Configure the Gateway: [Gateway configuration](/gateway/configuration)
- Keep OpenClaw up to date: [Updating](/install/updating)
