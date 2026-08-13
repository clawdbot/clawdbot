# OpenClaw on Cloudflare Containers (experimental)

This template runs one OpenClaw installation behind a Cloudflare Worker and one named Durable Object. The Durable Object starts a `standard-2` Container from a public, digest-pinned Docker Hub image. Litestream continuously replicates the global and per-agent SQLite databases to R2 through its S3-compatible API.

This is an experimental deployment target. Read [Operational constraints](#operational-constraints) before using it with real credentials or relying on it for recovery.

## Architecture

```text
HTTP/WebSocket request
        |
        v
Cloudflare Worker
        |
        v
OpenClawContainer Durable Object (one stable name)
        |
        v
OpenClaw + Litestream container :8080
        |
        +--> R2 S3 API (SQLite replicas)
```

Every HTTP and WebSocket request is forwarded to port `8080`. The Container helper polls `GET /healthz`, which every published image serves, before admitting traffic. `max_instances: 1` and the single Durable Object name are the installation's outer single-writer fence.

## Prerequisites

- A Cloudflare account with Workers, Containers, and R2 available
- Docker Buildx with `linux/amd64` support
- A public Docker Hub repository for the derived image
- Node.js and npm
- Model-provider and channel credentials for the OpenClaw setup you choose

## 1. Create the R2 bucket and S3 credentials

From this directory:

```bash
npm install
npx wrangler login
npx wrangler whoami
npx wrangler r2 bucket create openclaw-backups
```

In the Cloudflare dashboard, create an R2 API token with object read/write access limited to this bucket. Record its access key ID and secret access key. Do not put either value in this checkout.

Edit `wrangler.jsonc`:

- replace `<account-id>` in `LITESTREAM_ENDPOINT`
- change both `LITESTREAM_BUCKET` and `r2_buckets[].bucket_name` if you chose another bucket name

The R2 binding is present for Worker-side completeness. Litestream runs inside the Container and cannot consume a Worker binding directly, so it uses R2's S3 endpoint and Worker secrets passed through `envVars`.

## 2. Build and publish the image

Choose an immutable, architecture-compatible digest from the official [`openclaw/openclaw`](https://hub.docker.com/r/openclaw/openclaw) Docker Hub repository. Replace `<official-openclaw-image-digest>` in `Dockerfile`, then build and push the derived image:

```bash
docker buildx build \
  --platform linux/amd64 \
  --tag docker.io/<docker-hub-user>/openclaw-cloudflare:<version> \
  --push \
  .
```

Make the derived repository public. Resolve its pushed digest, then replace the `containers[].image` placeholder in `wrangler.jsonc`:

```bash
docker buildx imagetools inspect docker.io/<docker-hub-user>/openclaw-cloudflare:<version>
```

Use the resulting immutable `docker.io/<docker-hub-user>/openclaw-cloudflare@sha256:<digest>` reference. Cloudflare Containers can pull public Docker Hub images, but not GHCR images directly.

## 3. Deploy and set secrets

The first deploy creates the Worker, Durable Object migration, Container application, and R2 binding:

```bash
npm run check
npm run deploy
```

Immediately add the R2 and Gateway secrets. `wrangler secret put` prompts without writing the value to shell history:

```bash
npx wrangler secret put LITESTREAM_ACCESS_KEY_ID
npx wrangler secret put LITESTREAM_SECRET_ACCESS_KEY
npx wrangler secret put OPENCLAW_GATEWAY_TOKEN
```

Add the provider and channel variables needed by your installation, for example:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

`src/container.ts` passes the listed optional secret names to the Container. Add another explicit name there before using a different environment-backed provider or channel credential.

## 4. Bootstrap OpenClaw

Open the deployed Worker URL once to start the named instance. Then find the Container application and instance IDs:

```bash
npx wrangler containers list
npx wrangler containers instances <application-id> --json
npx wrangler containers ssh <instance-id>
```

Inside the Container, run the non-interactive SecretRef bootstrap. This example uses OpenAI and Telegram; select the provider and webhook-capable channel that match your secrets:

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

Keep the exact bootstrap recipe in a private, reproducible runbook. Litestream does not replicate `openclaw.json`, credential files, installed plugin files, or workspaces.

## 5. Verify before relying on it

```bash
curl -sS https://<worker-subdomain>.workers.dev/healthz
npx wrangler tail
```

Then rehearse recovery, because an untested restore path is not a backup: send one message, wait about ten seconds for replication, force a Container replacement, and confirm the conversation survives. Fix replication before connecting production channels if it does not.

Measured on this template against a real R2 bucket: about 2.4 s write-to-replica, about 9 s to restore both databases, and a healthy Gateway about 13 s after a fresh start.

## Scale-to-zero policy

The template defaults `OPENCLAW_WEBHOOK_ONLY` to `false`. This keeps the Container alive across idle periods for Discord, Slack Socket Mode, WhatsApp, and every other channel that maintains a socket or polling process.

Cost follows directly from that choice. Memory and disk bill on provisioned instance resources for as long as the Container is awake, so an always-on `standard-2` is dominated by its 6 GiB of provisioned memory rather than by agent activity -- roughly 40 to 50 US dollars per month at published rates, where a small always-on VM is often cheaper. A sleeping webhook-only Container bills nothing. Check [current rates](https://developers.cloudflare.com/containers/pricing/) before committing.

Set `OPENCLAW_WEBHOOK_ONLY` to `true` only when every enabled channel receives traffic through HTTP webhooks. The Container then stops after ten idle minutes and cold-starts on the next request. Because its disk is fresh after sleep, enable this only when an external process can reapply the declarative bootstrap above; Litestream alone restores SQLite, not the config files needed to activate channels.

## Operational constraints

- **Experimental:** Cloudflare Container lifecycle and rollout behavior can change. Test crash, sleep, rollout, and restore paths with non-production credentials first.
- **Single-writer fence:** Cloudflare guarantees one live Durable Object instance for a given name, and all Worker requests use the same name. This is the fence around one Litestream replica. A brief old/new Container overlap during replacement or rollout remains an accepted experimental tradeoff; do not raise `max_instances` or route around the named object.
- **Ephemeral disk:** Every Container restart or sleep starts with a fresh filesystem. The entrypoint lists R2 objects, derives the concrete SQLite restore manifest, restores each database, then starts OpenClaw under Litestream.
- **Partial durability:** Litestream covers `/home/node/.openclaw/state/*.sqlite` and recursive per-agent SQLite databases only. Use a separate, private [`openclaw backup create`](https://docs.openclaw.ai/install/backups#full-archives) workflow for config, credential files, plugins, and workspaces.
- **RPO:** `sync-interval: 1s` normally yields a seconds-scale recovery point, not zero data loss. Abrupt termination can lose writes that were not uploaded yet.
- **Rollback is time travel:** Restoring older state can desynchronize ratcheting channel credentials (especially WhatsApp), roll back approvals, and roll back delivery/dedupe state. Relink affected channels and review pending approvals before resuming.
- **WebSocket limit:** Cloudflare accepts received WebSocket messages up to 32 MiB. The Worker/Container proxy supports WebSockets; larger individual messages are closed by the platform.
- **Egress identity:** outbound traffic comes from shared Cloudflare IP space. Providers that require a fixed source IP need another deployment target or an approved egress design.
- **Not a `cloudWorkers` provider:** this is a hosting template. Operator SSH access is enabled for bootstrap, but the template does not implement OpenClaw's SSH-based cloud-worker provider contract.

## Updating

Build a new derived image from a new immutable official OpenClaw digest, push it, replace the derived digest in `wrangler.jsonc`, and run:

```bash
npm run check
npm run deploy
```

Treat rollbacks like restores: stop traffic where possible, preserve the current state first, and review credentials, approvals, and delivery state before activating older database bytes.

## Troubleshooting

- **Container never becomes ready:** the image must be `linux/amd64` and pulled from a public registry, referenced by digest rather than a moving tag.
- **Requests time out after a successful deploy:** the Container helper waits for `GET /healthz` on port `8080`; confirm the Gateway still binds that port.
- **A probe passes but nothing serves:** the Control UI answers unknown paths with a catch-all `200`, so probing a route the image does not serve looks healthy forever; assert the JSON body, not just the status.
- **Litestream authentication or signature errors:** Litestream needs R2 _S3 API_ credentials, not a Cloudflare API token, and `LITESTREAM_ENDPOINT` must contain the account ID.
- **First boot reports no databases to restore:** expected on an empty bucket; the entrypoint treats that as a fresh installation.
- **`/readyz` is 503 while `/startupz` is 200:** by design. Startup finished and a channel account is unhealthy; inspect channel status instead of restarting.
- **`wrangler containers ssh` rejected:** SSH ships disabled; add `"ssh": { "enabled": true }`, redeploy, then connect.
- **Config missing after sleep or redeploy:** Litestream restores SQLite only. Reapply the bootstrap runbook or stay always-on and take full archives.

Full operator guide: <https://docs.openclaw.ai/install/cloudflare>.

## Files

- `wrangler.jsonc`: Worker, Durable Object, Container application, and R2 binding
- `src/index.ts`: routes all HTTP and WebSocket traffic to one named instance
- `src/container.ts`: Container port, readiness, environment, and sleep policy
- `Dockerfile`: official OpenClaw image plus pinned Litestream for `linux/amd64`
- `entrypoint.sh`: R2 LIST restore discovery, containment checks, and restore-then-exec flow
- `litestream.yml`: watched global and per-agent SQLite directory replicas
