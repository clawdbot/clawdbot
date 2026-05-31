# Codex auth profile mixed profiles

```yaml qa-scenario
id: auth-profile-codex-mixed-profiles
title: Codex auth profile mixed profiles
surface: runtime
runtimeParityTier: standard
coverage:
  primary:
    - runtime.codex-plugin.auth
  secondary:
    - auth-profiles.provider-selection
objective: Verify mixed openai OAuth and openai API-key profile stores select the Codex OAuth profile for Codex app-server turns.
successCriteria:
  - The selected auth profile id is openai:qa-oauth.
  - The openai:media-api API-key profile is present but not selected.
  - The fixture rejects the residual provider mismatch covered by issue #78499.
docsRefs:
  - docs/cli/doctor.md
codeRefs:
  - extensions/qa-lab/src/auth-profile.fixture.ts
  - extensions/qa-lab/src/codex-plugin-lifecycle.test.ts
execution:
  kind: flow
  summary: Exercise the auth-profile fixture for mixed OpenAI API-key and Codex OAuth stores.
  config:
    selectedProfileId: openai:qa-oauth
    rejectedProfileId: openai:media-api
```

```yaml qa-flow
steps:
  - name: validates mixed-profile Codex auth selection
    actions:
      - set: auth
        value:
          expr: await qaImport("./auth-profile.fixture.js")
      - set: tmpRoot
        value:
          expr: await fs.mkdtemp(path.join(env.gateway?.workspaceDir ?? "/tmp", "qa-codex-auth-"))
      - try:
          actions:
            - call: auth.seedAuthProfiles
              args:
                - mixed
                - ref: tmpRoot
            - set: selection
              value:
                expr: auth.resolveCodexAuthProfile(await auth.snapshotAuthProfiles(tmpRoot))
            - assert:
                expr: "selection.status === 'ready'"
                message:
                  expr: "`expected ready Codex auth selection, got ${JSON.stringify(selection)}`"
            - assert:
                expr: "selection.profileId === config.selectedProfileId"
                message: mixed profiles must select openai OAuth
            - assert:
                expr: "selection.profileId !== config.rejectedProfileId"
                message: codex profile must not equal openai api-key profile
          finally:
            - call: fs.rm
              args:
                - ref: tmpRoot
                - recursive: true
                  force: true
      - assert:
          expr: "config.selectedProfileId !== config.rejectedProfileId"
          message: "codex profile must not equal openai api-key profile"
    detailsExpr: "`selected=${selection.profileId} rejected=${config.rejectedProfileId}`"
```
