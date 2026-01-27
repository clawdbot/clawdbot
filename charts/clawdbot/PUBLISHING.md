# Publishing the Clawdbot Helm Chart

This guide covers how to publish the Helm chart to make it available for users.

## Quick Start (Automated)

The chart is automatically published to GitHub Pages when you:

1. Update `charts/clawdbot/Chart.yaml` version
2. Commit and push to `main` branch
3. GitHub Actions automatically packages and publishes

## Publishing Methods

### Option 1: GitHub Pages (Recommended)

#### Initial Setup

1. **Enable GitHub Pages:**
   - Go to repository Settings → Pages
   - Source: Deploy from a branch
   - Branch: `gh-pages` → `/ (root)`
   - Click Save

2. **Create gh-pages branch (first time only):**
   ```bash
   # Create empty gh-pages branch
   git checkout --orphan gh-pages
   git rm -rf .
   echo "# Clawdbot Helm Charts" > README.md
   git add README.md
   git commit -m "Initial gh-pages"
   git push origin gh-pages
   git checkout main
   ```

3. **The workflow will automatically:**
   - Package the chart
   - Create a GitHub release
   - Update the chart repository index
   - Publish to GitHub Pages

#### Manual Publishing (if needed)

```bash
# 1. Package the chart
helm package charts/clawdbot -d .cr-release-packages

# 2. Create index
helm repo index .cr-release-packages --url https://clawdbot.github.io/clawdbot

# 3. Commit to gh-pages branch
git checkout gh-pages
cp .cr-release-packages/* .
git add .
git commit -m "Release chart version X.Y.Z"
git push origin gh-pages
git checkout main
```

#### Usage for End Users

Once published, users can install via:

```bash
# Add repo
helm repo add clawdbot https://clawdbot.github.io/clawdbot
helm repo update

# Install
helm install my-clawdbot clawdbot/clawdbot
```

### Option 2: OCI Registry (GitHub Container Registry)

Modern approach using OCI registries:

#### Setup

```bash
# Login to GHCR
echo $GITHUB_TOKEN | helm registry login ghcr.io -u USERNAME --password-stdin

# Package chart
helm package charts/clawdbot

# Push to GHCR
helm push clawdbot-1.0.0.tgz oci://ghcr.io/clawdbot
```

#### Automate in GitHub Actions

```yaml
- name: Login to GHCR
  uses: docker/login-action@v3
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Push chart to GHCR
  run: |
    helm package charts/clawdbot
    helm push clawdbot-*.tgz oci://ghcr.io/${{ github.repository_owner }}
```

#### Usage for End Users

```bash
# Install directly from OCI
helm install my-clawdbot oci://ghcr.io/clawdbot/clawdbot --version 1.0.0
```

### Option 3: Artifact Hub

Make your chart discoverable on [Artifact Hub](https://artifacthub.io).

#### Prerequisites

- Chart published to GitHub Pages or OCI registry
- Artifact Hub metadata file

#### Add Artifact Hub metadata

Create `charts/clawdbot/artifacthub-repo.yml`:

```yaml
repositoryID: <your-repo-id>
owners:
  - name: Clawdbot Team
    email: team@clawdbot.com
```

#### Submit to Artifact Hub

1. Go to https://artifacthub.io
2. Sign in with GitHub
3. Add repository
4. Provide repository URL: `https://clawdbot.github.io/clawdbot`
5. Wait for verification

### Option 4: ChartMuseum (Self-Hosted)

For private/internal charts:

```bash
# Run ChartMuseum
docker run -d \
  -p 8080:8080 \
  -v $(pwd)/charts:/charts \
  ghcr.io/helm/chartmuseum:latest \
  --storage local \
  --storage-local-rootdir /charts

# Upload chart
curl --data-binary "@clawdbot-1.0.0.tgz" http://localhost:8080/api/charts
```

## Versioning

Follow Semantic Versioning:

- **Chart version** (`version` in Chart.yaml): Chart changes
- **App version** (`appVersion` in Chart.yaml): Clawdbot version

### Bumping Versions

```bash
# Update chart version
vim charts/clawdbot/Chart.yaml
# Change version: 1.0.0 → 1.1.0

# Update app version (when clawdbot version changes)
vim charts/clawdbot/Chart.yaml
# Change appVersion: "2026.1.25" → "2026.1.26"
```

### Version Guidelines

- **Major** (1.0.0 → 2.0.0): Breaking changes to values.yaml or behavior
- **Minor** (1.0.0 → 1.1.0): New features, non-breaking changes
- **Patch** (1.0.0 → 1.0.1): Bug fixes, documentation

## Release Checklist

- [ ] Update `version` in `Chart.yaml`
- [ ] Update `appVersion` if clawdbot version changed
- [ ] Update `CHANGELOG.md` (if you have one)
- [ ] Test chart locally: `./scripts/test-helm-local.sh`
- [ ] Lint chart: `helm lint charts/clawdbot`
- [ ] Commit changes
- [ ] Push to main (triggers automated release)
- [ ] Verify GitHub Pages deployment
- [ ] Test installation from published repo

## Testing Published Chart

```bash
# Add your published repo
helm repo add clawdbot https://clawdbot.github.io/clawdbot
helm repo update

# Search for chart
helm search repo clawdbot

# Install from published repo
helm install test clawdbot/clawdbot --dry-run --debug
```

## Troubleshooting

### Chart not appearing after publish

1. Check GitHub Actions logs
2. Verify gh-pages branch exists
3. Check GitHub Pages settings are enabled
4. Wait 5-10 minutes for GitHub Pages to deploy

### Users getting "not found" error

```bash
# Check index.yaml exists
curl https://clawdbot.github.io/clawdbot/index.yaml

# Verify chart package exists
curl https://clawdbot.github.io/clawdbot/clawdbot-1.0.0.tgz
```

### Permission denied during publishing

Ensure GitHub Actions has write permissions:
- Settings → Actions → General → Workflow permissions
- Select "Read and write permissions"

## Advanced: Multi-Chart Repository

If you add more charts:

```
charts/
  clawdbot/
  clawdbot-operator/
  clawdbot-monitoring/
```

The `helm/chart-releaser-action` automatically handles multiple charts.

## References

- [Helm Chart Repository Guide](https://helm.sh/docs/topics/chart_repository/)
- [Chart Releaser Action](https://github.com/helm/chart-releaser-action)
- [Artifact Hub](https://artifacthub.io/docs/topics/repositories/)
- [OCI Registry Support](https://helm.sh/docs/topics/registries/)
