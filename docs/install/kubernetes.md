---
title: Kubernetes (Helm)
description: Deploy Clawdbot on Kubernetes using Helm charts
---

# Kubernetes Deployment

**Goal:** Clawdbot Gateway running on Kubernetes with Helm, persistent storage, automatic HTTPS, and channel access.

## What you need

- Kubernetes cluster (1.19+)
- kubectl CLI configured
- Helm 3.x
- Model auth: Anthropic API key (or other provider keys)
- Channel credentials: Discord bot token, Telegram token, etc.
- **Optional:** Ingress controller (NGINX, Traefik) for external access
- **Optional:** cert-manager for automatic TLS certificates

## Beginner quick path

1. Install Helm chart from source
2. Configure secrets (API keys)
3. Access Control UI via Ingress or port-forward
4. Configure channels

## Prerequisites

### 1) Kubernetes Cluster

You need a running Kubernetes cluster. Options:

**Local development:**
- Docker Desktop (macOS/Windows) - Enable Kubernetes in settings
- Minikube - `brew install minikube && minikube start`
- Kind - `brew install kind && kind create cluster`

**Cloud providers:**
- GKE (Google Kubernetes Engine)
- EKS (Amazon Elastic Kubernetes Service)
- AKS (Azure Kubernetes Service)
- DigitalOcean Kubernetes
- Linode Kubernetes Engine

### 2) kubectl

Install kubectl:

```bash
# macOS
brew install kubectl

# Linux
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Verify
kubectl version --client
kubectl cluster-info
```

### 3) Helm

Install Helm 3.x:

```bash
# macOS
brew install helm

# Linux
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Verify
helm version
```

## Installation

### 1) Clone the repository

```bash
git clone https://github.com/clawdbot/clawdbot.git
cd clawdbot
```

### 2) Install Helm chart

**Basic installation (development):**

```bash
helm install my-clawdbot charts/clawdbot \
  --set secrets.data.anthropicApiKey=sk-ant-xxx \
  --set secrets.data.gatewayToken=$(openssl rand -hex 32)
```

**With custom values file:**

```bash
helm install my-clawdbot charts/clawdbot \
  --values charts/clawdbot/examples/values-production.yaml \
  --set secrets.data.anthropicApiKey=sk-ant-xxx \
  --set ingress.hosts[0].host=assistant.example.com
```

**Create external secret (recommended for production):**

```bash
# Create secret
kubectl create secret generic clawdbot-secrets \
  --from-literal=gatewayToken=$(openssl rand -hex 32) \
  --from-literal=anthropicApiKey=sk-ant-xxx \
  --from-literal=discordBotToken=YOUR_DISCORD_TOKEN

# Install with external secret
helm install my-clawdbot charts/clawdbot \
  --values charts/clawdbot/examples/values-production.yaml \
  --set secrets.create=false \
  --set secrets.existingSecret=clawdbot-secrets
```

### 3) Verify installation

```bash
# Check deployment status
helm status my-clawdbot
kubectl get all -l app.kubernetes.io/instance=my-clawdbot

# Wait for pod to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=my-clawdbot --timeout=120s

# Check logs
kubectl logs -f my-clawdbot-0
```

## Access the Gateway

### Option 1: Port-forward (local access)

```bash
kubectl port-forward my-clawdbot-0 18789:18789
```

Then visit: http://localhost:18789

### Option 2: Ingress (external access)

**Install NGINX Ingress Controller (if not already installed):**

```bash
# For cloud providers
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.0/deploy/static/provider/cloud/deploy.yaml

# For bare metal/local
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.9.0/deploy/static/provider/baremetal/deploy.yaml

# For Minikube
minikube addons enable ingress

# For Kind
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml
```

**Enable Ingress in values:**

```yaml
ingress:
  enabled: true
  className: nginx
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod  # If using cert-manager
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    nginx.ingress.kubernetes.io/websocket-services: "my-clawdbot"
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

**Upgrade with Ingress:**

```bash
helm upgrade my-clawdbot charts/clawdbot \
  --reuse-values \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=assistant.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix
```

### 3) Get gateway token

```bash
kubectl get secret my-clawdbot -o jsonpath='{.data.gatewayToken}' | base64 -d && echo
```

Use this token to authenticate in the Control UI.

## Configuration

### Configure channels

#### Discord

```bash
# Exec into pod
kubectl exec -it my-clawdbot-0 -- sh

# Inside pod
node dist/index.js channels add --channel discord --token YOUR_DISCORD_BOT_TOKEN
```

Or set via secret:

```bash
kubectl create secret generic clawdbot-secrets \
  --from-literal=discordBotToken=YOUR_DISCORD_BOT_TOKEN \
  --dry-run=client -o yaml | kubectl apply -f -

# Restart pod to apply
kubectl delete pod my-clawdbot-0
```

#### Telegram

```bash
kubectl exec -it my-clawdbot-0 -- node dist/index.js channels add \
  --channel telegram \
  --token YOUR_TELEGRAM_BOT_TOKEN
```

#### WhatsApp (QR code)

```bash
# Exec into pod
kubectl exec -it my-clawdbot-0 -- node dist/index.js channels login
```

Scan the QR code with WhatsApp on your phone.

### Update configuration

Edit the config:

```bash
# Get current config
kubectl get configmap my-clawdbot-config -o yaml > clawdbot-config.yaml

# Edit clawdbot-config.yaml

# Apply changes
kubectl apply -f clawdbot-config.yaml

# Restart gateway to reload config
kubectl delete pod my-clawdbot-0
```

## Storage

The chart creates a persistent volume claim that stores:

- `/home/node/.clawdbot` - Config, sessions, device identity, SQLite databases
- `/home/node/clawd` - Agent workspace files

**Check storage:**

```bash
kubectl get pvc
kubectl describe pvc data-my-clawdbot-0
```

**Increase storage size:**

```yaml
persistence:
  size: 20Gi
```

## Upgrading

```bash
# Pull latest changes
cd clawdbot
git pull

# Upgrade with current values
helm upgrade my-clawdbot charts/clawdbot --reuse-values

# Upgrade with new values
helm upgrade my-clawdbot charts/clawdbot -f values-production.yaml
```

## Troubleshooting

### Pod not starting

```bash
# Check events
kubectl describe pod my-clawdbot-0

# Check logs
kubectl logs my-clawdbot-0

# If pod crashed
kubectl logs my-clawdbot-0 --previous
```

### OOM (Out of Memory)

Container keeps restarting. Signs: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration`, or silent restarts.

**Fix:** Increase memory in values.yaml:

```yaml
resources:
  limits:
    memory: 4Gi
  requests:
    memory: 1Gi
```

**Note:** 512MB is too small. 2GB recommended minimum.

### PVC not binding

```bash
# Check PVC status
kubectl get pvc

# Check events
kubectl describe pvc data-my-clawdbot-0

# Check if storage provisioner is available
kubectl get storageclass
```

**Fix for Minikube:**

```bash
minikube addons enable storage-provisioner
minikube addons enable default-storageclass
```

### Gateway lock issues

Gateway refuses to start with "already running" errors.

```bash
# Delete lock file
kubectl exec my-clawdbot-0 -- rm -f /home/node/.clawdbot/gateway.*.lock

# Restart pod
kubectl delete pod my-clawdbot-0
```

### WebSocket connections timing out

Ensure Ingress has proper annotations:

```yaml
annotations:
  nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
  nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
  nginx.ingress.kubernetes.io/websocket-services: "my-clawdbot"
```

### Config not being read

If using `--allow-unconfigured`, the gateway creates a minimal config. Your custom config should be read on restart.

```bash
# Verify config exists
kubectl exec my-clawdbot-0 -- cat /home/node/.clawdbot/clawdbot.json

# Verify ConfigMap
kubectl get configmap my-clawdbot-config -o yaml
```

### Image pull errors (local testing)

When testing with local images:

```bash
# Ensure pullPolicy is Never
--set image.pullPolicy=Never

# Load image into cluster
# Docker Desktop: Image already available
# Minikube: minikube image load clawdbot:local
# Kind: kind load docker-image clawdbot:local
```

## Local Testing

Test the Helm chart locally before deploying to production:

### Using Docker Desktop Kubernetes

```bash
# Enable Kubernetes in Docker Desktop settings

# Run automated test script
./scripts/test-helm-local.sh
```

### Using Minikube

```bash
# Start Minikube
minikube start --memory=4096 --cpus=2

# Build and load image
docker build -t clawdbot:local .
minikube image load clawdbot:local

# Install chart
helm install test charts/clawdbot \
  -f charts/clawdbot/examples/values-basic.yaml \
  --set image.repository=clawdbot \
  --set image.tag=local \
  --set image.pullPolicy=Never

# Access via port-forward
kubectl port-forward test-clawdbot-0 18789:18789
```

### Using Kind

```bash
# Create cluster
kind create cluster

# Build and load image
docker build -t clawdbot:local .
kind load docker-image clawdbot:local

# Install chart
helm install test charts/clawdbot \
  -f charts/clawdbot/examples/values-basic.yaml \
  --set image.repository=clawdbot \
  --set image.tag=local \
  --set image.pullPolicy=Never
```

## Uninstall

```bash
# Uninstall Helm release
helm uninstall my-clawdbot

# Delete PVCs (data will be lost)
kubectl delete pvc -l app.kubernetes.io/instance=my-clawdbot
```

## Notes

- Clawdbot is a **single-user application**. The chart enforces `replicas: 1`.
- WebSocket gateway requires long-lived connections (use proper Ingress timeouts).
- Persistent storage is required to preserve state across restarts.
- Docker-in-Docker sandboxing is disabled by default in Kubernetes deployments.
- For production, use external secret management (Kubernetes Secrets, External Secrets Operator, or Vault).

## Documentation

- [Chart README](https://github.com/clawdbot/clawdbot/tree/main/charts/clawdbot)
- [Clawdbot Documentation](https://docs.clawd.bot)
- [GitHub Repository](https://github.com/clawdbot/clawdbot)

## Cost

Kubernetes cluster costs vary by provider:

- **Local (free):** Docker Desktop, Minikube, Kind
- **Cloud providers:** $50-200/month depending on node size and region
- **Recommended resources:** 2 CPU, 4GB RAM minimum

See your cloud provider's pricing for details.
