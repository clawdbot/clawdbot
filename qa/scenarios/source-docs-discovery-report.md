# Source and docs discovery report

```yaml qa-scenario
id: source-docs-discovery-report
title: Source and docs discovery report
surface: discovery
objective: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
successCriteria:
  - Agent reads docs and source before proposing more tests.
  - Agent identifies extra candidate scenarios beyond the seed list.
  - Agent ends with a worked or failed QA report.
docsRefs:
  - docs/help/testing.md
  - docs/web/dashboard.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/report.ts
  - extensions/qa-lab/src/self-check.ts
  - src/agents/system-prompt.ts
execution:
  kind: flow
  summary: Verify the agent can read repo docs and source, expand the QA plan, and publish a worked or did-not-work report.
  config:
    requiredFiles:
      - repo/qa/scenarios/index.md
      - repo/extensions/qa-lab/src/suite.ts
      - repo/docs/help/testing.md
    prompt: Read the seeded docs and source plan. The full repo is mounted under ./repo/. Explicitly inspect repo/qa/scenarios/index.md, repo/extensions/qa-lab/src/suite.ts, and repo/docs/help/testing.md, then report grouped into Worked, Failed, Blocked, and Follow-up. Mention at least two extra QA scenarios beyond the seed list.
```

```yaml qa-flow
steps:
  - name: reads seeded material and emits a protocol report
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:discovery
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && hasDiscoveryLabels(candidate.text)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 20000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "!reportsMissingDiscoveryFiles(outbound.text)"
          message:
            expr: "`discovery report still missed repo files: ${outbound.text}`"
      - assert:
          expr: "!reportsDiscoveryScopeLeak(outbound.text)"
          message:
            expr: "`discovery report drifted beyond scope: ${outbound.text}`"
      # Parity gate criterion 2 (no fake progress / fake tool completion):
      # require an actual read tool call before the prose report. Without this,
      # a model could fabricate a plausible Worked/Failed/Blocked/Follow-up
      # report without ever touching the repo files the prompt names. The
      # debug request log is fetched once and reused for both the assertion
      # and its failure-message diagnostic. Each request's allInputText is
      # lowercased inline at match time (the real prompt writes it as
      # "Worked, Failed, Blocked") so the contains check is case-insensitive.
      - set: discoveryDebugRequests
        value:
          expr: "env.mock ? [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))] : []"
      - assert:
          expr: "!env.mock || discoveryDebugRequests.some((request) => String(request.allInputText ?? '').toLowerCase().includes('worked, failed, blocked') && request.plannedToolName === 'read')"
          message:
            expr: "`expected at least one read tool call during discovery report scenario, saw plannedToolNames=${JSON.stringify(discoveryDebugRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: outbound.text
```
