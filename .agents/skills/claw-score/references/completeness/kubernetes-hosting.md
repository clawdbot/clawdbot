# Kubernetes Hosting Completeness

Use this rubric when assigning category Completeness scores for the
`kubernetes-hosting` surface.

## Surface-Specific Scoring Questions

For each category, ask:

- Can an operator deploy and manage OpenClaw on Kubernetes end to end?
- Are the taxonomy features present as supported manifests, commands, and docs rather than examples only?
- Are setup, normal operation, status or inspection, redeploy, teardown, and secret rotation represented where relevant?
- Are local Kind validation, namespace/image customization, provider secrets, and secure exposure branches covered?
- Do known gaps leave major cluster-hosting capability branches missing?

## Surface-Specific Guidance

Variation from the default completeness process:

- Completeness is the Kubernetes operator workflow for deployment, configuration, secrets, access, exposure, lifecycle, security posture, status, and recovery.
- A complete Kubernetes category lets an operator deploy, expose, secure, update, troubleshoot, and remove the Gateway without relying on Docker-only assumptions.
- Happy-path port-forwarding, missing secret/config rotation, or omitted exposed-service security posture are material completeness gaps.

## Category Scope

- Deployment Setup: Kustomize packaging, cluster prerequisites, quick deploy, manifest apply, and Kind validation.
- Configuration and Secrets: agent instructions, Gateway config, provider secrets, secret rotation, and image/namespace customization.
- Access and Exposure: port-forward access, service endpoint, ingress exposure, auth/TLS, and localhost posture.
- Cluster Lifecycle: resource layout, state persistence, redeploy, teardown, and security context.
