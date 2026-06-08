---
title: "Kubernetes hosting - Access and Exposure Maturity Note"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Kubernetes hosting - Access and Exposure Maturity Note

## Summary

Docs recommend conservative access and exposure patterns. Service and config manifests expose a concrete ClusterIP path.

## Category Scope

This category covers the taxonomy-defined Access and Exposure capability area for the Kubernetes hosting surface.

## Features

- Port-forward access: kubectl port-forward path for local Gateway access.
- Service endpoint: Kubernetes Service access model for the Gateway.
- Ingress exposure: Ingress and load-balancer exposure beyond port-forward.
- Auth and TLS: Required authentication, TLS, and origin controls for exposed deployments.
- Localhost posture: Cluster-local runtime assumptions and localhost access boundaries.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` passed with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, and `repository_count=2`.
- discrawl: `discrawl status --json` passed with `generated_at=2026-06-01T23:01:14Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (43%)`
- Positive signals: Docs recommend conservative access and exposure patterns; Service and config manifests expose a concrete ClusterIP path.
- Negative signals: Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged; No Kubernetes access/exposure tests were found.
- Integration gaps: Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged; No Kubernetes access/exposure tests were found.

Coverage labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across the category. Unit tests can provide supporting context but never make a feature covered by themselves.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Global freshness check passed; no category-specific gitcrawl query was run in this surface-subagent scoring package.
- Discrawl reports: Global freshness check passed; no category-specific discrawl query was run in this surface-subagent scoring package.
- Good qualities: Docs recommend conservative access and exposure patterns; Service and config manifests expose a concrete ClusterIP path.
- Bad qualities: Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage were used only for Coverage and not as Quality inputs.

Quality labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage as a scoring input.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: Scored against `.agents/skills/claw-score/references/completeness/kubernetes-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Port-forward access, Service endpoint, Ingress exposure, Auth and TLS, Localhost posture.
- Negative signals: Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged; No Kubernetes access/exposure tests were found.
- Missing capability branches: Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged; No Kubernetes access/exposure tests were found.

Completeness labels: `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`, `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the higher maturity label.

Completeness measures how fully this category delivers the intended surface-specific capability set. The exact rubric comes from the scoring surface's taxonomy `completeness_instructions` file.

## Known Gaps

- Ingress, TLS, NetworkPolicy, and production exposure manifests are not packaged.
- No Kubernetes access/exposure tests were found.

## Evidence

### Docs

- `docs/install/kubernetes.md:76-81`
- `docs/install/kubernetes.md:143-151`
- `docs/install/kubernetes.md:169-176`
- `docs/gateway/remote.md:157-177`
- `docs/gateway/security/exposure-runbook.md:20-34`
- `docs/gateway/security/exposure-runbook.md:155-167`

### Source

- `scripts/k8s/manifests/service.yaml:1-15`
- `scripts/k8s/manifests/configmap.yaml:10-19`

### Integration tests

- None identified in this scoring slice.

### Unit tests

- No Kubernetes access/exposure tests found.

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
