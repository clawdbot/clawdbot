#!/usr/bin/env bash
# ============================================================================
# KIND CLUSTER BOOTSTRAP SCRIPT
# ============================================================================
#
# Usage:
#   ./scripts/k8s/create-kind.sh             # Create with auto-detected engine
#   ./scripts/k8s/create-kind.sh --name mycluster
#   ./scripts/k8s/create-kind.sh --delete
#
# After creation, deploy with:
#   export <AI_PROVIDER>_API_KEY="..." && ./scripts/k8s/deploy.sh
# ============================================================================

set -euo pipefail

# Defaults
CLUSTER_NAME="openclaw"
CONTAINER_CMD=""
DELETE=false

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
fail()    { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS]


Options:
  --name NAME          Cluster name (default: openclaw)
  --delete             Delete the cluster instead of creating it
  -h, --help           Show this help message

Examples:
  $(basename "$0")                          # Create cluster (auto-detect engine)
  $(basename "$0") --delete                 # Delete the cluster
  $(basename "$0") --name dev --delete      # Delete a cluster named "dev"
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      [[ -z "${2:-}" ]] && fail "--name requires a value"
      CLUSTER_NAME="$2"; shift 2 ;;
    --delete)
      DELETE=true; shift ;;
    -h|--help)
      usage ;;
    *)
      fail "Unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Container engine detection
# ---------------------------------------------------------------------------
provider_installed() {
  command -v "$1" &>/dev/null
}

provider_responsive() {
  case "$1" in
    docker)
      docker info &>/dev/null
      ;;
    podman)
      podman info &>/dev/null
      ;;
    *)
      return 1
      ;;
  esac
}

detect_provider() {
  local candidate

  for candidate in podman docker; do
    if provider_installed "$candidate" && provider_responsive "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  for candidate in podman docker; do
    if provider_installed "$candidate"; then
      case "$candidate" in
        podman)
          fail "Podman is installed but not responding, and no responsive Docker daemon was found. Ensure the podman machine is running (podman machine start) or start Docker."
          ;;
        docker)
          fail "Docker is installed but not running, and no responsive Podman machine was found. Start Docker or start Podman."
          ;;
      esac
    fi
  done

  fail "Neither podman nor docker found. Install one to use Kind."
}

CONTAINER_CMD=$(detect_provider)
info "Auto-detected container engine: $CONTAINER_CMD"

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
if ! command -v kind &>/dev/null; then
  fail "kind is not installed. Install it from https://kind.sigs.k8s.io/"
fi

if ! command -v kubectl &>/dev/null; then
  fail "kubectl is not installed. Install it before creating or managing a Kind cluster."
fi

# Verify the container engine is responsive
if ! provider_responsive "$CONTAINER_CMD"; then
  if [[ "$CONTAINER_CMD" == "docker" ]]; then
    fail "Docker daemon is not running. Start it and try again."
  elif [[ "$CONTAINER_CMD" == "podman" ]]; then
    fail "Podman is not responding. Ensure the podman machine is running (podman machine start)."
  fi
fi

# ---------------------------------------------------------------------------
# Delete mode
# ---------------------------------------------------------------------------
if $DELETE; then
  info "Deleting Kind cluster '$CLUSTER_NAME'..."
  if KIND_EXPERIMENTAL_PROVIDER="$CONTAINER_CMD" kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    KIND_EXPERIMENTAL_PROVIDER="$CONTAINER_CMD" kind delete cluster --name "$CLUSTER_NAME"
    success "Cluster '$CLUSTER_NAME' deleted."
  else
    warn "Cluster '$CLUSTER_NAME' does not exist."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Check if cluster already exists
# ---------------------------------------------------------------------------
if KIND_EXPERIMENTAL_PROVIDER="$CONTAINER_CMD" kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  warn "Cluster '$CLUSTER_NAME' already exists."
  info "To recreate it, run: $0 --name \"$CLUSTER_NAME\" --delete && $0 --name \"$CLUSTER_NAME\""
  info "Switching kubectl context to kind-$CLUSTER_NAME..."
  kubectl config use-context "kind-$CLUSTER_NAME" &>/dev/null && success "Context set." || warn "Could not switch context."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create cluster
# ---------------------------------------------------------------------------
info "Creating Kind cluster '$CLUSTER_NAME' (provider: $CONTAINER_CMD)..."

KIND_EXPERIMENTAL_PROVIDER="$CONTAINER_CMD" kind create cluster \
  --name "$CLUSTER_NAME" \
  --config - <<'KINDCFG'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
- role: control-plane
  labels:
    openclaw.dev/role: control-plane
  # Uncomment to expose services on host ports:
  # extraPortMappings:
  # - containerPort: 30080
  #   hostPort: 8080
  #   protocol: TCP
  # - containerPort: 30443
  #   hostPort: 8443
  #   protocol: TCP
KINDCFG

success "Kind cluster '$CLUSTER_NAME' created."

# ---------------------------------------------------------------------------
# Wait for readiness
# ---------------------------------------------------------------------------
info "Waiting for cluster to be ready..."
kubectl --context "kind-$CLUSTER_NAME" wait --for=condition=Ready nodes --all --timeout=120s >/dev/null
success "All nodes are Ready."

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "---------------------------------------------------------------"
echo " Kind cluster '$CLUSTER_NAME' is ready"
echo "---------------------------------------------------------------"
echo ""
echo "  kubectl cluster-info --context kind-$CLUSTER_NAME"
echo ""
echo ""
echo "  export <AI_PROVIDER>_API_KEY=\"...\" && ./scripts/k8s/deploy.sh"
echo ""
