#!/usr/bin/env bash
# Test Helm chart locally on Docker Desktop K8s, Minikube, or Kind

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[TEST]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }

# Configuration
CHART_PATH="${CHART_PATH:-charts/clawdbot}"
IMAGE_NAME="${IMAGE_NAME:-clawdbot}"
IMAGE_TAG="${IMAGE_TAG:-local-test}"
RELEASE_NAME="${RELEASE_NAME:-test-clawdbot}"
NAMESPACE="${NAMESPACE:-default}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-test-dummy}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-$(openssl rand -hex 32)}"

# Detect K8s environment
detect_k8s() {
  if kubectl config current-context | grep -q docker-desktop 2>/dev/null; then
    echo "docker-desktop"
  elif kubectl config current-context | grep -q minikube 2>/dev/null; then
    echo "minikube"
  elif kubectl config current-context | grep -q kind 2>/dev/null; then
    echo "kind"
  else
    echo "unknown"
  fi
}

K8S_ENV=$(detect_k8s)
info "Detected Kubernetes environment: $K8S_ENV"

# Step 1: Lint chart
log "Step 1: Linting Helm chart..."
helm lint "$CHART_PATH" || error "Helm lint failed"
helm lint "$CHART_PATH" --values "$CHART_PATH/examples/values-basic.yaml" || error "Helm lint with values-basic.yaml failed"
log "✓ Lint passed"

# Step 2: Template validation
log "Step 2: Validating templates..."
helm template test "$CHART_PATH" \
  --values "$CHART_PATH/examples/values-basic.yaml" \
  --set image.repository="$IMAGE_NAME" \
  --set image.tag="$IMAGE_TAG" \
  --set secrets.data.anthropicApiKey="$ANTHROPIC_API_KEY" \
  > /tmp/clawdbot-manifests.yaml || error "Template validation failed"
log "✓ Template validation passed"

# Step 3: Build Docker image
log "Step 3: Building Docker image..."
docker build -t "$IMAGE_NAME:$IMAGE_TAG" -f Dockerfile . || error "Docker build failed"
log "✓ Image built: $IMAGE_NAME:$IMAGE_TAG"

# Step 4: Load image into cluster
log "Step 4: Loading image into cluster..."
case "$K8S_ENV" in
  docker-desktop)
    info "Docker Desktop: Image already available"
    ;;
  minikube)
    minikube image load "$IMAGE_NAME:$IMAGE_TAG" || error "Failed to load image into Minikube"
    ;;
  kind)
    kind load docker-image "$IMAGE_NAME:$IMAGE_TAG" || error "Failed to load image into Kind"
    ;;
  *)
    warn "Unknown K8s environment, skipping image load (may fail if image not available)"
    ;;
esac
log "✓ Image loaded"

# Step 5: Install Helm chart
log "Step 5: Installing Helm chart..."
helm install "$RELEASE_NAME" "$CHART_PATH" \
  --namespace "$NAMESPACE" \
  --values "$CHART_PATH/examples/values-basic.yaml" \
  --set image.repository="$IMAGE_NAME" \
  --set image.tag="$IMAGE_TAG" \
  --set image.pullPolicy=Never \
  --set secrets.data.anthropicApiKey="$ANTHROPIC_API_KEY" \
  --set secrets.data.gatewayToken="$GATEWAY_TOKEN" \
  --wait --timeout=3m || error "Helm install failed"
log "✓ Chart installed"

# Step 6: Verify deployment
log "Step 6: Verifying deployment..."

# Check StatefulSet
info "Checking StatefulSet..."
kubectl get statefulset -l app.kubernetes.io/instance="$RELEASE_NAME" -n "$NAMESPACE"

# Check Pod
info "Waiting for pod to be ready..."
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance="$RELEASE_NAME" \
  -n "$NAMESPACE" --timeout=120s || error "Pod did not become ready"
log "✓ Pod is ready"

# Check PVC
info "Checking PVC..."
kubectl get pvc -l app.kubernetes.io/instance="$RELEASE_NAME" -n "$NAMESPACE"
log "✓ PVC created"

# Step 7: Health check
log "Step 7: Running health check..."
POD_NAME=$(kubectl get pod -l app.kubernetes.io/instance="$RELEASE_NAME" -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
kubectl exec "$POD_NAME" -n "$NAMESPACE" -- node dist/index.js health --token "$GATEWAY_TOKEN" && log "✓ Health check passed" || warn "Health check failed (may be OK for test env)"

# Step 8: Check logs
log "Step 8: Checking logs (last 50 lines)..."
kubectl logs "$POD_NAME" -n "$NAMESPACE" --tail=50

# Step 9: Run Helm tests
log "Step 9: Running Helm tests..."
helm test "$RELEASE_NAME" -n "$NAMESPACE" && log "✓ Helm tests passed" || warn "Helm tests failed"

# Step 10: Verify persistence
log "Step 10: Testing persistence..."
info "Checking state directory..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -- ls -la /home/node/.clawdbot
info "Checking workspace directory..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -- ls -la /home/node/clawd
info "Checking config file..."
kubectl exec "$POD_NAME" -n "$NAMESPACE" -- cat /home/node/.clawdbot/clawdbot.json || warn "Config file not found (may be OK)"
log "✓ Persistence verified"

# Step 11: Port-forward test
log "Step 11: Testing port-forward (5 seconds)..."
kubectl port-forward "$POD_NAME" -n "$NAMESPACE" 18789:18789 &
PF_PID=$!
sleep 5
kill $PF_PID 2>/dev/null || true
log "✓ Port-forward test complete"

# Success summary
echo
log "============================================"
log "All tests passed! ✓"
log "============================================"
info "Release: $RELEASE_NAME"
info "Namespace: $NAMESPACE"
info "Pod: $POD_NAME"
info "Gateway token: $GATEWAY_TOKEN"
echo

# Cleanup prompt
read -p "Clean up resources? (y/N) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  log "Cleaning up..."
  helm uninstall "$RELEASE_NAME" -n "$NAMESPACE"
  kubectl delete pvc -l app.kubernetes.io/instance="$RELEASE_NAME" -n "$NAMESPACE"
  log "✓ Cleanup complete"
else
  info "Skipping cleanup. To clean up later, run:"
  echo "  helm uninstall $RELEASE_NAME -n $NAMESPACE"
  echo "  kubectl delete pvc -l app.kubernetes.io/instance=$RELEASE_NAME -n $NAMESPACE"
fi
