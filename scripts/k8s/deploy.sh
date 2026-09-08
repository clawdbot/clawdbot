#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Deploy OpenClaw to Kubernetes.
#
# Secrets are generated in a temp directory and applied server-side.
# No secret material is ever written to the repo checkout.
#
# Usage:
#   ./scripts/k8s/deploy.sh                   # Deploy (requires API key in env or secret already in cluster)
#   ./scripts/k8s/deploy.sh --create-secret   # Create or update the K8s Secret from env vars
#   ./scripts/k8s/deploy.sh --show-token      # Print the gateway token after deploy
#   ./scripts/k8s/deploy.sh --delete          # Tear down safely for the selected namespace
#   ./scripts/k8s/deploy.sh --delete-resources # Delete OpenClaw resources only
#   ./scripts/k8s/deploy.sh --delete-namespace # Delete the namespace and all resources
#
# Environment:
#   OPENCLAW_NAMESPACE   Kubernetes namespace (default: openclaw)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFESTS="$SCRIPT_DIR/manifests"
NS="${OPENCLAW_NAMESPACE:-openclaw}"

# Check prerequisites
for cmd in kubectl openssl; do
  command -v "$cmd" &>/dev/null || { echo "Missing: $cmd" >&2; exit 1; }
done
kubectl cluster-info &>/dev/null || { echo "Cannot connect to cluster. Check kubeconfig." >&2; exit 1; }

# ---------------------------------------------------------------------------
# -h / --help
# ---------------------------------------------------------------------------
if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: ./scripts/k8s/deploy.sh [OPTION]

  (no args)        Deploy OpenClaw (creates secret from env if needed)
  --create-secret  Create or update the K8s Secret from env vars without deploying
  --show-token     Print the gateway token after deploy or secret creation
  --delete         Delete the default namespace, or resources only in a custom namespace
  --delete-resources
                  Delete OpenClaw resources from the namespace
  --delete-namespace
                  Delete the namespace and all resources in it
  -h, --help       Show this help

Environment:
  Export at least one provider API key:
    ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY

  OPENCLAW_NAMESPACE     Kubernetes namespace (default: openclaw)
HELP
  exit 0
fi

SHOW_TOKEN=false
MODE="deploy"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --create-secret)
      MODE="create-secret"
      ;;
    --delete)
      MODE="delete"
      ;;
    --delete-resources)
      MODE="delete-resources"
      ;;
    --delete-namespace)
      MODE="delete-namespace"
      ;;
    --show-token)
      SHOW_TOKEN=true
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Run ./scripts/k8s/deploy.sh --help for usage." >&2
      exit 1
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# --delete / --delete-namespace
# ---------------------------------------------------------------------------
if [[ "$MODE" == "delete" && "$NS" != "openclaw" ]]; then
  MODE="delete-resources"
fi

if [[ "$MODE" == "delete" || "$MODE" == "delete-namespace" ]]; then
  echo "Deleting namespace '$NS' and all resources..."
  kubectl delete namespace "$NS" --ignore-not-found
  echo "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# --delete-resources
# ---------------------------------------------------------------------------
if [[ "$MODE" == "delete-resources" ]]; then
  echo "Deleting OpenClaw resources from namespace '$NS'..."
  kubectl delete -k "$MANIFESTS" -n "$NS" --ignore-not-found
  kubectl delete secret openclaw-secrets -n "$NS" --ignore-not-found
  echo "Done."
  exit 0
fi

# ---------------------------------------------------------------------------
# Create and apply Secret to the cluster
# ---------------------------------------------------------------------------
_apply_secret() {
  local TMP_DIR
  local EXISTING_SECRET=false
  local EXISTING_TOKEN=""
  local ANTHROPIC_VALUE=""
  local OPENAI_VALUE=""
  local GEMINI_VALUE=""
  local OPENROUTER_VALUE=""
  local TOKEN
  local SECRET_MANIFEST
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  trap 'rm -rf "$TMP_DIR"' EXIT

  if kubectl get secret openclaw-secrets -n "$NS" &>/dev/null; then
    EXISTING_SECRET=true
    EXISTING_TOKEN="$(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d)"
    ANTHROPIC_VALUE="$(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.ANTHROPIC_API_KEY}' 2>/dev/null | base64 -d)"
    OPENAI_VALUE="$(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.OPENAI_API_KEY}' 2>/dev/null | base64 -d)"
    GEMINI_VALUE="$(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.GEMINI_API_KEY}' 2>/dev/null | base64 -d)"
    OPENROUTER_VALUE="$(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.OPENROUTER_API_KEY}' 2>/dev/null | base64 -d)"
  fi

  TOKEN="${EXISTING_TOKEN:-$(openssl rand -hex 32)}"
  ANTHROPIC_VALUE="${ANTHROPIC_API_KEY:-$ANTHROPIC_VALUE}"
  OPENAI_VALUE="${OPENAI_API_KEY:-$OPENAI_VALUE}"
  GEMINI_VALUE="${GEMINI_API_KEY:-$GEMINI_VALUE}"
  OPENROUTER_VALUE="${OPENROUTER_API_KEY:-$OPENROUTER_VALUE}"
  SECRET_MANIFEST="$TMP_DIR/secrets.yaml"

  # Write secret material to temp files so kubectl handles encoding safely.
  printf '%s' "$TOKEN" > "$TMP_DIR/OPENCLAW_GATEWAY_TOKEN"
  printf '%s' "$ANTHROPIC_VALUE" > "$TMP_DIR/ANTHROPIC_API_KEY"
  printf '%s' "$OPENAI_VALUE" > "$TMP_DIR/OPENAI_API_KEY"
  printf '%s' "$GEMINI_VALUE" > "$TMP_DIR/GEMINI_API_KEY"
  printf '%s' "$OPENROUTER_VALUE" > "$TMP_DIR/OPENROUTER_API_KEY"
  chmod 600 \
    "$TMP_DIR/OPENCLAW_GATEWAY_TOKEN" \
    "$TMP_DIR/ANTHROPIC_API_KEY" \
    "$TMP_DIR/OPENAI_API_KEY" \
    "$TMP_DIR/GEMINI_API_KEY" \
    "$TMP_DIR/OPENROUTER_API_KEY"

  kubectl create secret generic openclaw-secrets \
    -n "$NS" \
    --from-file=OPENCLAW_GATEWAY_TOKEN="$TMP_DIR/OPENCLAW_GATEWAY_TOKEN" \
    --from-file=ANTHROPIC_API_KEY="$TMP_DIR/ANTHROPIC_API_KEY" \
    --from-file=OPENAI_API_KEY="$TMP_DIR/OPENAI_API_KEY" \
    --from-file=GEMINI_API_KEY="$TMP_DIR/GEMINI_API_KEY" \
    --from-file=OPENROUTER_API_KEY="$TMP_DIR/OPENROUTER_API_KEY" \
    --dry-run=client \
    -o yaml > "$SECRET_MANIFEST"
  chmod 600 "$SECRET_MANIFEST"

  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl apply --server-side --field-manager=openclaw -f "$SECRET_MANIFEST" >/dev/null
  # Clean up any annotation left by older client-side apply runs.
  kubectl annotate secret openclaw-secrets -n "$NS" kubectl.kubernetes.io/last-applied-configuration- >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
  trap - EXIT

  if $EXISTING_SECRET; then
    echo "Secret updated in namespace '$NS'. Existing gateway token preserved."
  else
    echo "Secret created in namespace '$NS'."
  fi

  if $SHOW_TOKEN; then
    echo "Gateway token: $TOKEN"
  else
    echo "Gateway token stored in Secret only."
    echo "Retrieve it with:"
    echo "  kubectl get secret openclaw-secrets -n $NS -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d && echo"
  fi
}

# ---------------------------------------------------------------------------
# --create-secret
# ---------------------------------------------------------------------------
if [[ "$MODE" == "create-secret" ]]; then
  HAS_KEY=false
  for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    if [[ -n "${!key:-}" ]]; then
      HAS_KEY=true
      echo "  Found $key in environment"
    fi
  done

  if ! $HAS_KEY; then
    echo "No API keys found in environment. Export at least one and re-run:"
    echo "  export <PROVIDER>_API_KEY=\"...\"  (ANTHROPIC, GEMINI, OPENAI, or OPENROUTER)"
    echo "  ./scripts/k8s/deploy.sh --create-secret"
    exit 1
  fi

  _apply_secret
  echo ""
  echo "Now run:"
  echo "  ./scripts/k8s/deploy.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# Check that the secret exists in the cluster
# ---------------------------------------------------------------------------
if ! kubectl get secret openclaw-secrets -n "$NS" &>/dev/null; then
  HAS_KEY=false
  for key in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    [[ -n "${!key:-}" ]] && HAS_KEY=true
  done

  if $HAS_KEY; then
    echo "Creating secret from environment..."
    _apply_secret
    echo ""
  else
    echo "No secret found and no API keys in environment."
    echo ""
    echo "Export at least one provider API key and re-run:"
    echo "  export <PROVIDER>_API_KEY=\"...\"  (ANTHROPIC, GEMINI, OPENAI, or OPENROUTER)"
    echo "  ./scripts/k8s/deploy.sh"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo "Deploying to namespace '$NS'..."
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -k "$MANIFESTS" -n "$NS"
kubectl rollout restart deployment/openclaw -n "$NS" 2>/dev/null || true
echo ""
echo "Waiting for rollout..."
kubectl rollout status deployment/openclaw -n "$NS" --timeout=300s
echo ""
echo "Done. Access the gateway:"
echo "  kubectl port-forward svc/openclaw 18789:18789 -n $NS"
echo "  open http://localhost:18789"
echo ""
if $SHOW_TOKEN; then
  echo "Gateway token (paste into Control UI):"
  echo "  $(kubectl get secret openclaw-secrets -n "$NS" -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d)"
echo ""
fi
echo "Retrieve the gateway token with:"
echo "  kubectl get secret openclaw-secrets -n $NS -o jsonpath='{.data.OPENCLAW_GATEWAY_TOKEN}' | base64 -d && echo"
