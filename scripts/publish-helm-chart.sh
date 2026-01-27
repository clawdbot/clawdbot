#!/usr/bin/env bash
# Publish Helm chart to GitHub Pages

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[PUBLISH]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
info() { echo -e "${BLUE}[INFO]${NC} $*"; }

# Configuration
CHART_PATH="charts/clawdbot"
REPO_URL="https://clawdbot.github.io/clawdbot"
OUTPUT_DIR=".cr-release-packages"

# Check prerequisites
command -v helm >/dev/null 2>&1 || error "helm not found. Install it first."
command -v git >/dev/null 2>&1 || error "git not found."

# Get chart version
CHART_VERSION=$(grep '^version:' "$CHART_PATH/Chart.yaml" | awk '{print $2}')
APP_VERSION=$(grep '^appVersion:' "$CHART_PATH/Chart.yaml" | awk '{print $2}' | tr -d '"')

log "Publishing Helm Chart"
info "Chart version: $CHART_VERSION"
info "App version: $APP_VERSION"

# Confirm
read -p "Continue with publishing? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  warn "Publishing cancelled"
  exit 0
fi

# Step 1: Lint chart
log "Step 1: Linting chart..."
helm lint "$CHART_PATH" || error "Chart lint failed"

# Step 2: Package chart
log "Step 2: Packaging chart..."
mkdir -p "$OUTPUT_DIR"
helm package "$CHART_PATH" -d "$OUTPUT_DIR" || error "Chart packaging failed"
info "Packaged: $OUTPUT_DIR/clawdbot-${CHART_VERSION}.tgz"

# Step 3: Generate index
log "Step 3: Generating repository index..."

# Check if we're on gh-pages branch
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "gh-pages" ]; then
  warn "Not on gh-pages branch. Switching..."

  # Stash current changes if any
  if ! git diff-index --quiet HEAD --; then
    log "Stashing current changes..."
    git stash push -m "publish-helm-chart: stash before gh-pages"
  fi

  # Switch to gh-pages
  git checkout gh-pages || {
    error "Failed to checkout gh-pages branch. Create it first:

    git checkout --orphan gh-pages
    git rm -rf .
    echo '# Clawdbot Helm Charts' > README.md
    git add README.md
    git commit -m 'Initial gh-pages'
    git push origin gh-pages
    git checkout main"
  }
fi

# Copy package to gh-pages root
log "Step 4: Copying package to gh-pages..."
cp "$OUTPUT_DIR/clawdbot-${CHART_VERSION}.tgz" .

# Update or create index.yaml
if [ -f "index.yaml" ]; then
  log "Updating existing index.yaml..."
  helm repo index . --url "$REPO_URL" --merge index.yaml
else
  log "Creating new index.yaml..."
  helm repo index . --url "$REPO_URL"
fi

# Step 5: Commit and push
log "Step 5: Committing to gh-pages..."
git add "clawdbot-${CHART_VERSION}.tgz" index.yaml

if git diff --staged --quiet; then
  warn "No changes to commit. Chart version $CHART_VERSION may already be published."
else
  git commit -m "Release chart version ${CHART_VERSION}

  Chart: clawdbot ${CHART_VERSION}
  App: ${APP_VERSION}

  Published via scripts/publish-helm-chart.sh"

  log "Step 6: Pushing to origin/gh-pages..."
  git push origin gh-pages || error "Failed to push to gh-pages"

  log "✓ Chart published successfully!"
  info "Version: $CHART_VERSION"
  info "URL: $REPO_URL/clawdbot-${CHART_VERSION}.tgz"
fi

# Step 7: Switch back to original branch
log "Switching back to $CURRENT_BRANCH..."
git checkout "$CURRENT_BRANCH"

# Restore stash if we created one
if git stash list | grep -q "publish-helm-chart: stash before gh-pages"; then
  log "Restoring stashed changes..."
  git stash pop
fi

# Clean up
rm -rf "$OUTPUT_DIR"

echo
log "============================================"
log "Chart published successfully! ✓"
log "============================================"
echo
info "Users can now install with:"
echo
echo "  helm repo add clawdbot $REPO_URL"
echo "  helm repo update"
echo "  helm install my-clawdbot clawdbot/clawdbot"
echo
info "Chart URL: $REPO_URL/clawdbot-${CHART_VERSION}.tgz"
info "Wait 5-10 minutes for GitHub Pages to deploy"
echo
info "Verify deployment:"
echo "  curl $REPO_URL/index.yaml"
