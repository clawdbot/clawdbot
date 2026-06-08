---
title: "Kubernetes hosting Maturity Report"
version: 3
last_refreshed: 2026-06-01
last_refreshed_by: codex
---

# Kubernetes hosting Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (50%)`
- Quality: `Beta (75%)`
- Completeness: `Beta (74%)`
- LTS Features: `0/4`

## Summary

Kubernetes hosting is a real but early cluster-hosting path. Docs, scripts, and Kustomize manifests support minimal Gateway deployment, Kind bootstrap, Kubernetes Secrets, ConfigMap config, PVC state, ClusterIP Service, probes, and conservative loopback access. Main gaps are missing Kubernetes-specific automated/live CI, no packaged ingress/TLS/NetworkPolicy/backup path, and production exposure guidance that is advisory rather than represented in manifests.

This report was scored from `source_ref=openclaw@29dd7847fd` with one subagent dedicated to this surface. Global archive freshness checks passed before scoring: `gitcrawl doctor --json` and `discrawl status --json`.

## Matrix

| Category                                                  | LTS | Coverage             | Quality      | Completeness   | Features to evaluate                                                                       |
| --------------------------------------------------------- | --- | -------------------- | ------------ | -------------- | ------------------------------------------------------------------------------------------ |
| [Deployment Setup](deployment-setup.md)                   | ❌  | `Alpha (55%)`        | `Beta (76%)` | `Stable (84%)` | Kustomize packaging, Cluster prerequisites, Quick deploy, Manifest apply, Kind validation  |
| [Configuration and Secrets](configuration-and-secrets.md) | ❌  | `Alpha (52%)`        | `Beta (74%)` | `Beta (76%)`   | Agent instructions, Gateway config, Provider secrets, Secret rotation, Image and namespace |
| [Access and Exposure](access-and-exposure.md)             | ❌  | `Experimental (43%)` | `Beta (72%)` | `Alpha (58%)`  | Port-forward access, Service endpoint, Ingress exposure, Auth and TLS, Localhost posture   |
| [Cluster Lifecycle](cluster-lifecycle.md)                 | ❌  | `Alpha (50%)`        | `Beta (78%)` | `Beta (77%)`   | Resource layout, State persistence, Redeploy, Teardown, Security context                   |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.
