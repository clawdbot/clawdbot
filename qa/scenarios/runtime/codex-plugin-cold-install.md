# Codex plugin cold install

```yaml qa-scenario
id: codex-plugin-cold-install
title: Codex plugin cold install
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.lifecycle
  secondary:
    - runtime.doctor-repair
objective: Verify a clean home that needs the Codex runtime reports a clear missing-plugin remediation, installs through doctor repair, and retries through Codex OAuth instead of OpenAI API-key auth.
successCriteria:
  - Missing Codex plugin emits the exact remediation string asserted by the fixture test.
  - Doctor repair seeds the Codex plugin before retrying the agent turn.
  - The retry uses the openai-codex OAuth profile and never routes through the openai API-key profile.
docsRefs:
  - docs/cli/doctor.md
  - docs/cli/plugins.md
  - docs/plugins/install-overrides.md
codeRefs:
  - extensions/qa-lab/src/codex-plugin.fixture.ts
  - extensions/qa-lab/src/auth-profile.fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Exercise the Codex lifecycle fixture for missing plugin repair and retry auth routing.
  config:
    remediation: Codex plugin is required for Codex runtime. Run "openclaw doctor --fix" to install @openclaw/codex, then retry.
```

```yaml qa-flow
steps:
  - name: validates cold-install repair routing
    actions:
      - set: auth
        value:
          expr: await qaImport("./auth-profile.fixture.js")
      - set: plugin
        value:
          expr: await qaImport("./codex-plugin.fixture.js")
      - set: tmpRoot
        value:
          expr: await fs.mkdtemp(path.join(env.gateway?.workspaceDir ?? "/tmp", "qa-codex-cold-"))
      - set: agentDir
        value:
          expr: path.join(tmpRoot, "agents", "qa", "agent")
      - try:
          actions:
            - call: plugin.seedCodexPluginAt
              args:
                - missing
                - ref: agentDir
            - call: auth.seedAuthProfiles
              args:
                - mixed
                - ref: agentDir
            - set: missing
              value:
                expr: "plugin.evaluateCodexPluginLifecycle({ plugin: await plugin.snapshotCodexPluginState(agentDir), auth: await auth.snapshotAuthProfiles(agentDir), hostVersion: plugin.CODEX_PLUGIN_CURRENT_VERSION })"
            - assert:
                expr: "missing.status === 'repair-required'"
                message:
                  expr: "`expected repair-required, got ${JSON.stringify(missing)}`"
            - assert:
                expr: "missing.remediation === config.remediation"
                message: missing Codex plugin remediation drifted
            - assert:
                expr: "missing.selectedAuthProfileId === auth.QA_CODEX_OAUTH_PROFILE_ID"
                message: missing-plugin repair must keep Codex OAuth selected
            - call: plugin.seedCodexPluginAt
              args:
                - current
                - ref: agentDir
            - set: repaired
              value:
                expr: "plugin.evaluateCodexPluginLifecycle({ plugin: await plugin.snapshotCodexPluginState(agentDir), auth: await auth.snapshotAuthProfiles(agentDir), hostVersion: plugin.CODEX_PLUGIN_CURRENT_VERSION })"
            - assert:
                expr: "repaired.status === 'ready' && repaired.tokenRoute === 'codex-oauth'"
                message:
                  expr: "`expected repaired Codex OAuth route, got ${JSON.stringify(repaired)}`"
          finally:
            - call: fs.rm
              args:
                - ref: tmpRoot
                - recursive: true
                  force: true
    detailsExpr: "`missing=${missing.status} repaired=${repaired.status} route=${repaired.tokenRoute}`"
```
