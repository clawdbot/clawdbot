---
summary: "Cloud worker provider backed by the Crabbox CLI."
read_when:
  - You are installing, configuring, or auditing the crabbox plugin
title: "Crabbox plugin"
---

# Crabbox plugin

Cloud worker provider backed by the Crabbox CLI.

## Distribution

- Package: `@openclaw/crabbox-provider`
- Install route: included in OpenClaw

## Surface

contracts: `workerProviders`

<!-- openclaw-plugin-reference:manual-start -->

## Configure

See [Cloud worker environments](/gateway/configuration-reference#crabbox-profile) for the profile schema and lifecycle notes.

Forward Gateway environment variables to an operator-provided setup script by listing their names in the Crabbox profile settings:

```json5 validate=false
{
  setup: 'install-worker "$OPENCLAW_WORKER_ARTIFACT_TOKEN"',
  setupEnv: ["OPENCLAW_WORKER_ARTIFACT_TOKEN"],
}
```

`setupEnv` explicitly forwards up to 16 unique environment variable names to the setup command only. Values are read from the Gateway process environment and are never stored in the profile configuration. Missing variables fail before a machine is allocated.

<!-- openclaw-plugin-reference:manual-end -->
