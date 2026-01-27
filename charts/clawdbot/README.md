# Clawdbot Helm Chart

Personal AI assistant with multi-channel support (WhatsApp, Telegram, Discord, and more) running on Kubernetes.

## TL;DR

```bash
helm install my-clawdbot ./clawdbot \
  --set secrets.data.anthropicApiKey=sk-ant-xxx \
  --set secrets.data.gatewayToken=$(openssl rand -hex 32)
```

## Introduction

This chart deploys Clawdbot Gateway on a Kubernetes cluster using the Helm package manager.

**Important:** Clawdbot is designed as a single-user personal assistant. The chart enforces `replicas: 1` and does not support horizontal scaling.

## Prerequisites

- Kubernetes 1.19+
- Helm 3.x
- PV provisioner support in the underlying infrastructure (for persistent storage)
- **Optional:** Ingress controller (NGINX, Traefik, etc.) for external access
- **Optional:** cert-manager for automatic TLS certificates

## Installing the Chart

### Basic Installation

```bash
helm install my-clawdbot ./clawdbot
```

### With Custom Values

```bash
helm install my-clawdbot ./clawdbot \
  --values examples/values-production.yaml \
  --set secrets.data.anthropicApiKey=sk-ant-xxx \
  --set ingress.hosts[0].host=assistant.example.com
```

### From Examples

```bash
# Basic (local testing)
helm install my-clawdbot ./clawdbot -f examples/values-basic.yaml

# Production
helm install my-clawdbot ./clawdbot -f examples/values-production.yaml

# Fly.io-like setup
helm install my-clawdbot ./clawdbot -f examples/values-fly-like.yaml
```

## Uninstalling the Chart

```bash
helm uninstall my-clawdbot

# Also delete PVCs (data will be lost)
kubectl delete pvc -l app.kubernetes.io/instance=my-clawdbot
```

## Configuration

### Key Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of replicas (must be 1) | `1` |
| `image.repository` | Clawdbot image repository | `clawdbot/clawdbot` |
| `image.tag` | Image tag | Chart appVersion |
| `gateway.bind` | Gateway binding mode (`loopback`, `lan`, `auto`) | `lan` |
| `gateway.port` | Gateway port | `18789` |
| `secrets.data.anthropicApiKey` | Anthropic API key | `""` |
| `secrets.data.openaiApiKey` | OpenAI API key | `""` |
| `secrets.data.gatewayToken` | Gateway authentication token (auto-generated if empty) | `""` |
| `persistence.enabled` | Enable persistent storage | `true` |
| `persistence.size` | PVC size | `10Gi` |
| `ingress.enabled` | Enable Ingress | `false` |
| `ingress.className` | Ingress class | `nginx` |
| `resources.limits.memory` | Memory limit | `2Gi` |
| `resources.requests.memory` | Memory request | `512Mi` |

### Full Values Reference

See [values.yaml](values.yaml) for all available parameters.

## Storage

The chart creates a StatefulSet with a persistent volume claim template that mounts storage at two locations:

- `/home/node/.clawdbot` (subPath: `clawdbot-state`) - Configuration, sessions, device identity, SQLite databases
- `/home/node/clawd` (subPath: `clawdbot-workspace`) - Agent workspace files

**Storage Class:** By default, uses the cluster's default storage class. Override with `persistence.storageClass`.

**Size Recommendations:**
- Development/Testing: 5-10Gi
- Production (single user): 20Gi+
- Depends on session history and workspace usage

## Secrets Management

### Option 1: Inline Secrets (Development Only)

```bash
helm install my-clawdbot ./clawdbot \
  --set secrets.data.anthropicApiKey=sk-ant-xxx \
  --set secrets.data.gatewayToken=$(openssl rand -hex 32)
```

### Option 2: External Secret (Production)

Create a Kubernetes Secret:

```bash
kubectl create secret generic clawdbot-secrets \
  --from-literal=gatewayToken=$(openssl rand -hex 32) \
  --from-literal=anthropicApiKey=sk-ant-xxx \
  --from-literal=discordBotToken=MTQ...
```

Install with existing secret:

```bash
helm install my-clawdbot ./clawdbot \
  --set secrets.create=false \
  --set secrets.existingSecret=clawdbot-secrets
```

### Option 3: External Secrets Operator

Use External Secrets Operator to sync from Vault, AWS Secrets Manager, etc.

## Ingress

### NGINX Ingress Controller

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/websocket-services: "{{ include \"clawdbot.fullname\" . }}"
  hosts:
    - host: assistant.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: clawdbot-tls
      hosts:
        - assistant.example.com
```

**Important:** WebSocket support requires extended timeouts (3600s recommended).

### Traefik

```yaml
ingress:
  className: traefik
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
```

## Health Checks

The chart uses exec-based probes that run the CLI health command:

```yaml
livenessProbe:
  exec:
    command:
      - sh
      - -c
      - node dist/index.js health --token "${CLAWDBOT_GATEWAY_TOKEN}" || exit 1
```

## Upgrading

```bash
# Pull latest chart changes
git pull

# Upgrade with current values
helm upgrade my-clawdbot ./clawdbot --reuse-values

# Upgrade with new values
helm upgrade my-clawdbot ./clawdbot -f values-production.yaml
```

## Troubleshooting

### Pod Not Starting

```bash
# Check pod events
kubectl describe pod my-clawdbot-0

# Check logs
kubectl logs my-clawdbot-0
```

### OOM (Out of Memory)

Increase memory limits:

```yaml
resources:
  limits:
    memory: 4Gi
  requests:
    memory: 1Gi
```

**Note:** 512MB is too small for production. 2GB recommended minimum.

### PVC Not Binding

```bash
# Check PVC status
kubectl get pvc

# Check storage class
kubectl get storageclass

# Describe for events
kubectl describe pvc data-my-clawdbot-0
```

### WebSocket Connections Timing Out

Ensure Ingress has WebSocket annotations:

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

### Gateway Lock File Issues

If the gateway won't start due to stale lock files:

```bash
kubectl exec my-clawdbot-0 -- rm -f /home/node/.clawdbot/gateway.*.lock
kubectl delete pod my-clawdbot-0  # Restart pod
```

## Examples

### Local Testing (Minikube/Kind/Docker Desktop)

```bash
# Build local image
docker build -t clawdbot:local .

# Load into cluster (example for Minikube)
minikube image load clawdbot:local

# Install chart
helm install test ./clawdbot \
  -f examples/values-basic.yaml \
  --set image.repository=clawdbot \
  --set image.tag=local \
  --set image.pullPolicy=Never
```

### Production Deployment

```bash
# Create external secret first
kubectl create secret generic clawdbot-secrets \
  --from-literal=gatewayToken=$(openssl rand -hex 32) \
  --from-literal=anthropicApiKey=$ANTHROPIC_API_KEY

# Install with production values
helm install my-clawdbot ./clawdbot -f examples/values-production.yaml
```

## Documentation

- [Clawdbot Documentation](https://docs.clawd.bot)
- [Kubernetes Installation Guide](https://docs.clawd.bot/install/kubernetes)
- [GitHub Repository](https://github.com/clawdbot/clawdbot)

## Support

- [GitHub Issues](https://github.com/clawdbot/clawdbot/issues)
- [Documentation](https://docs.clawd.bot)

## License

See [LICENSE](https://github.com/clawdbot/clawdbot/blob/main/LICENSE)
