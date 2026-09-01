---
summary: "Deploy OpenClaw Gateway to a Kubernetes cluster with Kustomize"
read_when:
  - You want to run OpenClaw on a Kubernetes cluster
  - You want to test OpenClaw in a Kubernetes environment
title: "Kubernetes"
---

A minimal starting point for running OpenClaw on Kubernetes, not a production-ready deployment. It covers the core resources and is meant to be adapted to your environment.

## Why not Helm

OpenClaw is a single container with some config files. The interesting customization is in agent content (Markdown files, skills, config overrides), not infrastructure templating. Kustomize handles overlays without the overhead of a Helm chart. Layer a Helm chart on top of these manifests if your deployment grows more complex.

## What you need

- A running Kubernetes cluster (AKS, EKS, GKE, k3s, kind, OpenShift, etc.)
- `kubectl` connected to your cluster
- An API key for at least one model provider

## Quick start

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh

kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://127.0.0.1:18789
```

`deploy.sh` creates token auth by default. Retrieve the generated gateway token for the Control UI:

```bash
kubectl get secret openclaw-secrets -n openclaw -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d
```

For local debugging, `./scripts/k8s/deploy.sh --show-token` prints the token after deploy.

## Local testing with Kind

If you do not have a cluster, create one locally with [Kind](https://kind.sigs.k8s.io/):

```bash
./scripts/k8s/create-kind.sh           # auto-detects docker or podman
./scripts/k8s/create-kind.sh --delete  # tear down
```

Then deploy as usual with `./scripts/k8s/deploy.sh`.

## Step by step

### 1) Deploy

**Option A: API key in environment (one step)**

```bash
# Replace with your provider: ANTHROPIC, GEMINI, OPENAI, or OPENROUTER
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh
```

The script creates a Kubernetes Secret with the API key and an auto-generated gateway token, then deploys. If the Secret already exists, it preserves the current gateway token and any provider keys not being changed.

**Option B: create the secret separately**

```bash
export <PROVIDER>_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Add `--show-token` to either command to print the token to stdout for local testing.

### 2) Access the gateway

```bash
kubectl port-forward svc/openclaw 18789:18789 -n openclaw
open http://127.0.0.1:18789
```

## What gets deployed

```text
Namespace: openclaw (configurable via OPENCLAW_NAMESPACE)
├── Deployment/openclaw        # Single pod, init container + gateway
├── Service/openclaw           # ClusterIP on port 18789
├── PersistentVolumeClaim      # 10Gi for agent state and config
├── ConfigMap/openclaw-config  # openclaw.json + AGENTS.md
└── Secret/openclaw-secrets    # Gateway token + API keys
```

The Deployment probes `/readyz` for startup and traffic readiness with a five-minute startup budget, and `/healthz` for liveness. Every probe asserts the JSON probe contract rather than the status code alone, because the Control UI answers unknown paths with a catch-all `200`; a status-only check would pass forever against an image whose probe route does not exist yet.

`/startupz` is the better traffic-admission probe because it ignores channel health, so one failing channel account cannot evict an otherwise healthy Gateway from Service endpoints. It requires an image built from the release that introduced it, which is newer than the tag pinned above. After pinning such an image, switch the startup and readiness probes to `/startupz` and keep `/readyz` for monitoring that should include channel-account health.

## Customization

### Agent instructions

Edit the `AGENTS.md` in `scripts/k8s/manifests/configmap.yaml` and redeploy:

```bash
./scripts/k8s/deploy.sh
```

### Gateway config

Edit `openclaw.json` in `scripts/k8s/manifests/configmap.yaml`. See [Gateway configuration](/gateway/configuration) for the full reference.

The init container seeds `openclaw.json` and workspace `AGENTS.md` only when each file is missing from the PVC. The persisted copy is the source of truth after first boot: changes made through OpenClaw (`onboard`, `channels add`, `doctor --fix`, Control UI) survive pod restarts, and updating the ConfigMap does not overwrite an existing PVC copy. To intentionally reseed a file from an updated ConfigMap, delete the persisted copy and restart:

```bash
kubectl exec -n openclaw deploy/openclaw -- rm /home/node/.openclaw/openclaw.json
kubectl rollout restart -n openclaw deploy/openclaw
```

Deployments created from the previous template applied ConfigMap edits on every pod start (and discarded any config changes made through OpenClaw). If you relied on that flow, use the reseed commands above after ConfigMap edits.

### Add providers

Re-run with additional keys exported:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
./scripts/k8s/deploy.sh --create-secret
./scripts/k8s/deploy.sh
```

Existing provider keys stay in the Secret unless you overwrite them.

Or patch the Secret directly:

```bash
kubectl patch secret openclaw-secrets -n openclaw \
  -p '{"stringData":{"<PROVIDER>_API_KEY":"..."}}'
kubectl rollout restart deployment/openclaw -n openclaw
```

### Custom namespace

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh
```

### Custom image

Edit the `image` field in `scripts/k8s/manifests/deployment.yaml`:

```yaml
# Bump this immutable versioned tag when upgrading OpenClaw.
image: ghcr.io/openclaw/openclaw:2026.7.1-2-slim
```

### Expose beyond port-forward

The default manifests bind the gateway to loopback inside the pod. That works with `kubectl port-forward`, but not with a Kubernetes `Service` or Ingress path that needs to reach the pod IP directly.

To expose the gateway through an Ingress or load balancer:

- Change the gateway bind in `scripts/k8s/manifests/configmap.yaml` from `loopback` to a non-loopback bind that matches your deployment model.
- Keep gateway auth enabled and use a proper TLS-terminated entrypoint.
- Configure the Control UI for remote access using the supported web security model (for example HTTPS/Tailscale Serve and explicit allowed origins when needed).

## Re-deploy

```bash
./scripts/k8s/deploy.sh
```

This applies all manifests and restarts the pod to pick up any config or secret changes.

## Teardown

```bash
./scripts/k8s/deploy.sh --delete
```

For the default `openclaw` namespace, this deletes the namespace and everything in it, including the PVC.

For a custom namespace, `--delete` removes only OpenClaw resources and preserves the namespace and unrelated workloads:

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh --delete
```

Use `--delete-resources` to request this scoped teardown explicitly in any namespace. Both scoped modes delete the OpenClaw Deployment, Service, PVC, ConfigMap, and generated Secret. Deleting the PVC removes OpenClaw's claim and access to its persisted data; whether the backing volume and data are deleted depends on the PersistentVolume or StorageClass reclaim policy (`Delete` or `Retain`).

To delete a custom namespace and every workload in it, explicitly opt in:

```bash
OPENCLAW_NAMESPACE=my-namespace ./scripts/k8s/deploy.sh --delete-namespace
```

This also deletes unrelated workloads and the PVC.

## Architecture notes

- The gateway binds to loopback inside the pod by default, so the included setup is for `kubectl port-forward`.
- No cluster-scoped resources; everything lives in a single namespace.
- Security hardening: `readOnlyRootFilesystem`, `drop: ALL` capabilities, non-root user (UID 1000).
- The default config keeps the Control UI on the safer local-access path: loopback bind plus `kubectl port-forward` to `http://127.0.0.1:18789`.
- If you move beyond localhost access, use the supported remote model: HTTPS/Tailscale plus the appropriate gateway bind and Control UI origin settings.
- Secrets are generated in a temp directory and applied directly to the cluster; no secret material is written to the repo checkout.

## File structure

```text
scripts/k8s/
├── deploy.sh                   # Creates namespace + secret, deploys via kustomize
├── create-kind.sh              # Local Kind cluster (auto-detects docker/podman)
└── manifests/
    ├── kustomization.yaml      # Kustomize base
    ├── configmap.yaml          # openclaw.json + AGENTS.md
    ├── deployment.yaml         # Pod spec with security hardening
    ├── pvc.yaml                # 10Gi persistent storage
    └── service.yaml            # ClusterIP on 18789
```

## Related

- [Docker](/install/docker)
- [Docker VM runtime](/install/docker-vm-runtime)
- [Install overview](/install)
