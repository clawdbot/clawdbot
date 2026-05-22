# Codex doctor migration safety matrix

```yaml qa-scenario
id: auth-profile-doctor-migration-safety
title: Codex doctor migration safety matrix
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.doctor-repair
  secondary:
    - runtime.codex-plugin.auth
objective: Reproduce the four manual doctor-migration cells as an automated fixture matrix for Codex OAuth selection and stale Pi runtime pin removal.
successCriteria:
  - OAuth-only hosts select the openai-codex OAuth profile and use the Codex harness.
  - Mixed-profile hosts still select openai-codex OAuth when an openai API-key profile exists.
  - Mixed-profile defaults-level pi runtime pins are stripped by doctor repair.
  - Mixed-profile per-agent pi runtime pins are stripped by doctor repair.
docsRefs:
  - docs/cli/doctor.md
codeRefs:
  - extensions/qa-lab/src/auth-profile.fixture.ts
  - extensions/qa-lab/src/codex-plugin.fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Exercise the four-cell doctor migration matrix against Codex auth and stale Pi runtime pins.
  config:
    matrixCells:
      - oauth-only
      - mixed-no-pin
      - mixed-defaults-pi-pin
      - mixed-main-agent-pi-pin
```

```yaml qa-flow
steps:
  - name: validates doctor migration safety matrix
    actions:
      - set: auth
        value:
          expr: await qaImport("./auth-profile.fixture.js")
      - set: plugin
        value:
          expr: await qaImport("./codex-plugin.fixture.js")
      - forEach:
          items:
            ref: config.matrixCells
          item: cell
          actions:
            - set: tmpRoot
              value:
                expr: await fs.mkdtemp(path.join(env.gateway?.workspaceDir ?? "/tmp", `qa-codex-doctor-${cell}-`))
            - set: profileShape
              value:
                expr: "cell === 'oauth-only' ? 'oauth-only' : 'mixed'"
            - set: doctorConfig
              value:
                expr: "cell === 'mixed-defaults-pi-pin' ? { agents: { defaults: { agentRuntime: { id: 'pi' } } } } : cell === 'mixed-main-agent-pi-pin' ? { agents: { list: { main: { agentRuntime: { id: 'pi' } } } } } : {}"
            - try:
                actions:
                  - call: plugin.seedCodexPluginAt
                    args:
                      - current
                      - ref: tmpRoot
                  - call: auth.seedAuthProfiles
                    args:
                      - ref: profileShape
                      - ref: tmpRoot
                  - set: result
                    value:
                      expr: "plugin.evaluateCodexPluginLifecycle({ plugin: await plugin.snapshotCodexPluginState(tmpRoot), auth: await auth.snapshotAuthProfiles(tmpRoot), hostVersion: plugin.CODEX_PLUGIN_CURRENT_VERSION, config: doctorConfig, doctorFix: true })"
                  - assert:
                      expr: "result.status === 'ready' && result.selectedAuthProfileId === auth.QA_CODEX_OAUTH_PROFILE_ID && result.tokenRoute === 'codex-oauth'"
                      message:
                        expr: "`doctor matrix cell ${cell} failed Codex auth routing: ${JSON.stringify(result)}`"
                  - assert:
                      expr: "(Object.keys(doctorConfig).length === 0 && result.removedRuntimePins.length === 0) || result.removedRuntimePins.includes('agentRuntime.id=pi')"
                      message:
                        expr: "`doctor matrix cell ${cell} did not report stale Pi pin cleanup: ${JSON.stringify(result)}`"
                finally:
                  - call: fs.rm
                    args:
                      - ref: tmpRoot
                      - recursive: true
                        force: true
      - assert:
          expr: "config.matrixCells.length === 4"
          message: "expected four doctor migration cells"
    detailsExpr: "`cells=${config.matrixCells.join(',')}`"
```
