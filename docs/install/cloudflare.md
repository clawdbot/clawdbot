---
summary: "Experimental Cloudflare Worker and Container deployment with Litestream backups to R2"
title: "Cloudflare Containers"
read_when:
  - You want to run OpenClaw on Cloudflare Containers
  - You are evaluating R2-backed SQLite recovery on ephemeral containers
  - You need to choose between webhook scale-to-zero and always-on channels
---

Run one OpenClaw installation behind a Cloudflare Worker and a named Durable Object, with the official OpenClaw image and Litestream replication to R2.

<Warning>
  This deployment target is experimental. Litestream protects SQLite databases, not the complete OpenClaw state directory. Read [Limits and recovery](#limits-and-recovery) before using production credentials.
</Warning>

## What you need

- A Cloudflare account with Workers, Containers, and R2 available
- Docker Buildx with `linux/amd64` support
- A public Docker Hub repository for the derived image
- Node.js and npm
- Provider and channel credentials for your OpenClaw setup

The template lives in [`scripts/cloudflare`](https://github.com/openclaw/openclaw/tree/main/scripts/cloudflare). It deploys a `standard-2` Container with `max_instances: 1`.

## How it works

The Worker forwards every HTTP and WebSocket request to one stable Durable Object name. That Durable Object owns one Container instance and is the single-writer fence around the Litestream replica. The Container exposes OpenClaw on port `8080`; `/startupz` is its traffic-readiness check.

Litestream watches both SQLite roots:

- `/home/node/.openclaw/state/*.sqlite`
- `/home/node/.openclaw/agents/**/*.sqlite`

At boot, the entrypoint uses R2's S3 `ListObjectsV2` API as the restore manifest, rejects paths outside those roots, restores each discovered database, and only then starts the Gateway.

## Deploy

<Steps>
  <Step title="Prepare the template">
    Clone OpenClaw and enter the template directory:

    ```bash
    git clone https://github.com/openclaw/openclaw.git
    cd openclaw/scripts/cloudflare
    npm install
    npx wrangler login
    npx wrangler whoami
    ```

    Confirm that Wrangler selected the intended Cloudflare account before creating resources.

  </Step>

  <Step title="Create R2 storage">
    Create the bucket:

    ```bash
    npx wrangler r2 bucket create openclaw-backups
    ```

    In the Cloudflare dashboard, create an R2 API token with object read/write access limited to that bucket. Keep the access key ID and secret access key out of the checkout.

    In `wrangler.jsonc`, replace `<account-id>` in the endpoint. If you use another bucket name, update both `LITESTREAM_BUCKET` and `r2_buckets[].bucket_name`.

    The R2 binding is for Worker-side access and documentation completeness. Litestream cannot use a Worker binding from inside the Container; it uses R2's S3 endpoint and credentials passed through Worker secrets.

  </Step>

  <Step title="Publish the Container image">
    Replace `<official-openclaw-image-digest>` in `Dockerfile` with an immutable digest from the official [`openclaw/openclaw`](https://hub.docker.com/r/openclaw/openclaw) Docker Hub repository.

    Build the derived image for Cloudflare's required architecture and push it to a public Docker Hub repository:

    ```bash
    docker buildx build \
      --platform linux/amd64 \
      --tag docker.io/<docker-hub-user>/openclaw-cloudflare:<version> \
      --push \
      .
    docker buildx imagetools inspect \
      docker.io/<docker-hub-user>/openclaw-cloudflare:<version>
    ```

    Replace the `containers[].image` placeholder in `wrangler.jsonc` with the resulting immutable `docker.io/...@sha256:...` reference. Cloudflare Containers can pull public Docker Hub images directly; GHCR is not a supported source for this template.

  </Step>

  <Step title="Deploy the Worker and Container">
    Compile the Worker and deploy it:

    ```bash
    npm run check
    npm run deploy
    ```

    The first deployment creates the Worker, the SQLite-backed Durable Object class, the Container application, and the R2 binding.

  </Step>

  <Step title="Set runtime secrets">
    Add the R2 and Gateway credentials through Wrangler's secret prompt:

    ```bash
    npx wrangler secret put LITESTREAM_ACCESS_KEY_ID
    npx wrangler secret put LITESTREAM_SECRET_ACCESS_KEY
    npx wrangler secret put OPENCLAW_GATEWAY_TOKEN
    ```

    Add provider and channel variables as needed. For example:

    ```bash
    npx wrangler secret put OPENAI_API_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    ```

    `src/container.ts` passes an explicit allowlist of environment variables to the Container. Add another name there before using a different environment-backed credential.

  </Step>

  <Step title="Bootstrap OpenClaw">
    First boot needs one interactive session inside the Container. SSH access ships disabled; enable it temporarily by adding this to the container entry in `wrangler.jsonc`, then redeploy:

    ```jsonc
    "ssh": { "enabled": true }
    ```

    Open the deployed Worker URL once to start the instance. Then locate the application and instance IDs and connect:

    ```bash
    npx wrangler containers list
    npx wrangler containers instances <application-id> --json
    npx wrangler containers ssh <instance-id>
    ```

    SSH is wrangler-mediated and limited to accounts with container write access. After bootstrap you can remove the `ssh` block and redeploy; the restored state survives the replacement via Litestream.

    Inside the Container, run a SecretRef-based setup. This example uses OpenAI and Telegram:

    ```bash
    cd /app
    node openclaw.mjs onboard --non-interactive --accept-risk --skip-health \
      --mode local \
      --auth-choice openai-api-key \
      --secret-input-mode ref \
      --gateway-auth token \
      --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN \
      --skip-channels \
      --no-install-daemon
    node openclaw.mjs channels add --channel telegram --use-env
    node openclaw.mjs doctor --json
    ```

    Keep your exact bootstrap recipe in a private, reproducible runbook. A fresh Container disk does not retain the generated config.

  </Step>
</Steps>

## Choose the lifecycle mode

`OPENCLAW_WEBHOOK_ONLY` defaults to `false`, which keeps the Container running through idle periods. Keep this default for channels that maintain sockets or long-lived processes, including:

- Discord
- Slack Socket Mode
- WhatsApp

Set `OPENCLAW_WEBHOOK_ONLY` to `true` only when every enabled channel receives traffic through HTTP webhooks. In that mode, the Container stops after ten idle minutes and cold-starts on the next request.

<Warning>
  Scale-to-zero starts with a fresh disk. Enable it only when an external process can reapply your declarative bootstrap. Litestream restores SQLite but cannot recreate `openclaw.json`, credential files, installed plugins, or workspaces.
</Warning>

## Limits and recovery

- **Single writer:** every request resolves the same Durable Object name, and Cloudflare runs one live Durable Object instance for that name. Do not increase `max_instances` or introduce alternate routing around this fence. A brief old/new Container overlap during a platform replacement or rollout is an accepted experimental tradeoff.
- **Recovery point:** the one-second Litestream sync interval normally produces a seconds-scale RPO. It is not synchronous replication, and abrupt termination can lose writes that have not reached R2.
- **Ephemeral disk:** every sleep, replacement, or host restart starts from the image plus the restored SQLite databases. Use [full OpenClaw archives](/install/backups#full-archives) for config, credential files, plugin files, and workspaces.
- **Rollback:** older database bytes are time travel. Ratcheting channel credentials, especially WhatsApp, can desynchronize; approvals and delivery/dedupe state also roll back. Relink affected channels and review pending approvals before resuming. See [Restore](/install/backups#restore).
- **WebSockets:** Worker and Container proxying supports WebSockets. Cloudflare limits each received WebSocket message to 32 MiB.
- **Egress:** outbound requests use shared Cloudflare IP space. This target does not provide a fixed egress address.
- **Provider boundary:** this is a deployment template, not an OpenClaw `cloudWorkers` provider. Its operator SSH access does not implement that provider's SSH execution contract.

## Update

Build a new derived image from a new immutable official OpenClaw digest, push it, update the derived digest in `wrangler.jsonc`, and deploy:

```bash
npm run check
npm run deploy
```

Test updates and rollbacks against a separate R2 bucket first. Preserve current state before activating older bytes.

## Related

- [Backups](/install/backups)
- [Docker](/install/docker)
- [Gateway security](/gateway/security)
- [Secrets management](/gateway/secrets)
