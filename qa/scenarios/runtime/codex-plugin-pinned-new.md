# Codex plugin pinned new

```yaml qa-scenario
id: codex-plugin-pinned-new
title: Codex plugin pinned new
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.version
objective: Verify a Codex plugin pinned ahead of the OpenClaw host version fails closed with a precise host-upgrade remediation.
successCriteria:
  - The lifecycle fixture detects the plugin version is newer than the host version.
  - The failure remediation points to upgrading OpenClaw or installing a Codex plugin pinned to the host version.
  - The remediation string is asserted literally by the Phase 3 test.
docsRefs:
  - docs/cli/plugins.md
  - docs/cli/update.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin.fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Exercise the lifecycle fixture for pinned-new Codex plugin mismatch.
  config:
    pluginVersion: 2026.5.22
    hostVersion: 2026.5.21
    pluginRelation: newer
    remediation: Codex plugin version 2026.5.22 requires a newer OpenClaw host than 2026.5.21. Upgrade OpenClaw or install a codex plugin version pinned to 2026.5.21.
```

```yaml qa-flow
steps:
  - name: validates pinned-new remediation
    actions:
      - set: auth
        value:
          expr: await qaImport("./auth-profile.fixture.js")
      - set: plugin
        value:
          expr: await qaImport("./codex-plugin.fixture.js")
      - set: tmpRoot
        value:
          expr: await fs.mkdtemp(path.join(env.gateway?.workspaceDir ?? "/tmp", "qa-codex-new-"))
      - try:
          actions:
            - call: plugin.seedCodexPluginAt
              args:
                - expr: config.pluginVersion
                - ref: tmpRoot
            - call: auth.seedAuthProfiles
              args:
                - oauth-only
                - ref: tmpRoot
            - set: result
              value:
                expr: "plugin.evaluateCodexPluginLifecycle({ plugin: await plugin.snapshotCodexPluginState(tmpRoot), auth: await auth.snapshotAuthProfiles(tmpRoot), hostVersion: config.hostVersion })"
            - assert:
                expr: "result.status === 'blocked'"
                message:
                  expr: "`expected blocked pinned-new plugin, got ${JSON.stringify(result)}`"
            - assert:
                expr: "result.remediation === config.remediation"
                message: pinned-new remediation drifted
          finally:
            - call: fs.rm
              args:
                - ref: tmpRoot
                - recursive: true
                  force: true
      - assert:
          expr: "config.pluginRelation === 'newer'"
          message: "expected plugin version to be newer than host"
    detailsExpr: "`plugin=${config.pluginVersion} host=${config.hostVersion} status=${result.status}`"
```
