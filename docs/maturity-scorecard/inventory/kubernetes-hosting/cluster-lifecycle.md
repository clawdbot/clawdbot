---
title: "Kubernetes hosting - Cluster Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Kubernetes hosting - Cluster Lifecycle Maturity Note

## Summary

Docs and manifests cover local lifecycle, probes, PVC state, and basic restart behavior. Deployment script handles rollout-adjacent setup steps.

## Category Scope

This category covers the taxonomy-defined Cluster Lifecycle capability area for the Kubernetes hosting surface.

## Features

- Resource layout: Namespace, Deployment, Service, PVC, ConfigMap, and Secret inventory.
- State persistence: PVC-backed state expectations and cleanup implications.
- Redeploy: Re-apply manifests and restart pod workflow.
- Teardown: Namespace deletion and PVC cleanup path.
- Security context: Pod security, namespace scope, and runtime isolation notes.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (50%)`
- Positive signals: Docs and manifests cover local lifecycle, probes, PVC state, and basic restart behavior; Deployment script handles rollout-adjacent setup steps.
- Negative signals: Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged; No Kubernetes lifecycle tests were found.
- Integration gaps: Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged; No Kubernetes lifecycle tests were found.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs and manifests cover local lifecycle, probes, PVC state, and basic restart behavior; Deployment script handles rollout-adjacent setup steps.
- Bad qualities: Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Beta (77%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/kubernetes-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Resource layout, State persistence, Redeploy, Teardown, Security context.
- Negative signals: Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged; No Kubernetes lifecycle tests were found.
- Missing capability branches: Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged; No Kubernetes lifecycle tests were found.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Backup/restore, upgrade, scaling, and cluster operational runbooks are not fully packaged.
- No Kubernetes lifecycle tests were found.

## Evidence

### Docs

- `docs/install/kubernetes.md:83-92`
- `docs/install/kubernetes.md:153-167`
- `docs/install/kubernetes.md:169-176`
- `docs/gateway/index.md:40-49`
- `docs/gateway/index.md:135-147`

### Source

- `scripts/k8s/deploy.sh:75-79`
- `scripts/k8s/deploy.sh:213-219`
- `scripts/k8s/manifests/deployment.yaml:12-23`
- `scripts/k8s/manifests/deployment.yaml:99-146`
- `scripts/k8s/manifests/pvc.yaml:1-12`

### Integration tests

- None identified in this scoring slice.

### Unit tests

- No Kubernetes lifecycle tests found.

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
