---
title: "Kubernetes hosting - Configuration and Secrets Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Kubernetes hosting - Configuration and Secrets Maturity Note

## Summary

Docs and deployment scripts cover Kubernetes Secrets and ConfigMap-backed Gateway configuration. Deployment manifest wires config, secret, and runtime environment into the pod.

## Category Scope

This category covers the taxonomy-defined Configuration and Secrets capability area for the Kubernetes hosting surface.

## Features

- Agent instructions: ConfigMap-based agent instruction injection.
- Gateway config: ConfigMap-based Gateway configuration.
- Provider secrets: Kubernetes Secret-backed provider-key setup.
- Secret rotation: Provider-key patching and redeploy expectations.
- Image and namespace: Custom image pinning and namespace override.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (52%)`
- Positive signals: Docs and deployment scripts cover Kubernetes Secrets and ConfigMap-backed Gateway configuration; Deployment manifest wires config, secret, and runtime environment into the pod.
- Negative signals: No Kubernetes secret/config automated tests were found; Secret rotation and production hardening are not deeply packaged.
- Integration gaps: No Kubernetes secret/config automated tests were found; Secret rotation and production hardening are not deeply packaged.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs and deployment scripts cover Kubernetes Secrets and ConfigMap-backed Gateway configuration; Deployment manifest wires config, secret, and runtime environment into the pod.
- Bad qualities: Secret rotation and production hardening are not deeply packaged.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/kubernetes-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Agent instructions, Gateway config, Provider secrets, Secret rotation, Image and namespace.
- Negative signals: No Kubernetes secret/config automated tests were found; Secret rotation and production hardening are not deeply packaged.
- Missing capability branches: No Kubernetes secret/config automated tests were found; Secret rotation and production hardening are not deeply packaged.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- No Kubernetes secret/config automated tests were found.
- Secret rotation and production hardening are not deeply packaged.

## Evidence

### Docs

- `docs/install/kubernetes.md:94-141`
- `docs/gateway/secrets.md:25-37`
- `docs/help/environment.md:25-36`

### Source

- `scripts/k8s/deploy.sh:85-159`
- `scripts/k8s/deploy.sh:164-207`
- `scripts/k8s/manifests/configmap.yaml:8-38`
- `scripts/k8s/manifests/deployment.yaml:63-98`

### Integration tests

- None identified in this scoring slice.

### Unit tests

- No Kubernetes secret/config tests found.

### Surface validation commands

- `gitcrawl doctor --json`: `pass` - Archive freshness was verified before scoring.
- `discrawl status --json`: `pass` - Discord archive freshness was verified before scoring.

### Gitcrawl queries

Query: global freshness check only.

Results:

- `gitcrawl doctor --json` passed; category-specific issue queries were not run in this surface-subagent scoring package.

### Discrawl queries

Query: global freshness check only.

Results:

- `discrawl status --json` passed; category-specific Discord searches were not run in this surface-subagent scoring package.

## Audit Provenance

- Score source: `docs/kevinslin/maturity-scorecard/inventory/kubernetes-hosting/scores.yaml`.
- Taxonomy metadata source: `.agents/skills/claw-score/taxonomy.yaml`.
- OpenClaw source ref: `openclaw@29dd7847fd`.
