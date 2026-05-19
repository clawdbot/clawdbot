# Dreaming shadow trial report

```yaml qa-scenario
id: dreaming-shadow-trial-report
title: Dreaming shadow trial report
surface: memory
coverage:
  primary:
    - memory.dreaming
  secondary:
    - memory.promotion
    - qa.artifact-safety
risk: medium
capabilities:
  - tools.read
  - tools.write
  - channel.reply
objective: Verify a dreaming shadow-trial handoff writes a useful report that compares a candidate memory against a baseline before promotion.
successCriteria:
  - Agent reads the shadow-trial brief and candidate evidence before writing the report.
  - Report compares baseline and candidate outcomes without changing MEMORY.md.
  - Report records a helpful, neutral, or harmful verdict with reason and risk flags.
  - Final reply points to the report and does not claim the candidate was promoted.
docsRefs:
  - docs/concepts/dreaming.md
  - docs/concepts/memory.md
codeRefs:
  - extensions/memory-core/src/dreaming.ts
  - extensions/memory-core/src/dreaming-phases.ts
  - extensions/qa-lab/src/providers/mock-openai/server.ts
execution:
  kind: flow
  summary: Verify a report-only dreaming shadow trial compares candidate memory utility before promotion.
  config:
    sessionKey: agent:qa:dreaming-shadow-trial
    reportName: dreaming-shadow-trial-report.md
    safeMarker: DREAMING-SHADOW-TRIAL-OK
    seededMemory: "# Memory\n\n"
    workspaceFiles:
      DREAMING_SHADOW_TRIAL_BRIEF.md: |-
        # Dreaming shadow trial brief

        Write a report-only shadow trial for a candidate memory. Do not edit MEMORY.md.

        Required report contract:
        1. Read DREAMING_SHADOW_TRIAL_BRIEF.md.
        2. Read DREAMING_CANDIDATE_EVIDENCE.md.
        3. Write ./dreaming-shadow-trial-report.md.
        4. Include: Candidate, Trial prompt, Baseline outcome, Candidate outcome, Verdict, Reason, Risk flags, Promotion action.
        5. For this seeded evidence, Verdict must be helpful.
        6. Promotion action must be report-only.
      DREAMING_CANDIDATE_EVIDENCE.md: |-
        # Candidate evidence

        Candidate memory: The user prefers release reports that include exact verification commands and remaining risk.
        Trial prompt: Prepare a release readiness reply for a local OpenClaw QA change.
        Baseline outcome: mentions tests passed but omits the exact command and remaining risk.
        Candidate outcome: includes the exact verification command and calls out the remaining review risk.
        Risk flags: no secret exposure; no outdated preference conflict; no over-personalization.
    prompt: |-
      Dreaming shadow trial report check. Read DREAMING_SHADOW_TRIAL_BRIEF.md and DREAMING_CANDIDATE_EVIDENCE.md first.
      Then write ./dreaming-shadow-trial-report.md as a report-only shadow trial.
      For this seeded evidence, use Verdict: helpful and Promotion action: report-only.
      Do not edit MEMORY.md and do not claim the candidate was promoted.
      Reply with the report path and exact marker DREAMING-SHADOW-TRIAL-OK.
    expectedReportAll:
      - "candidate:"
      - "exact verification commands and remaining risk"
      - "trial prompt:"
      - "baseline outcome:"
      - "omits the exact command and remaining risk"
      - "candidate outcome:"
      - "calls out the remaining review risk"
      - "verdict: helpful"
      - "reason:"
      - "risk flags:"
      - "no secret exposure"
      - "promotion action: report-only"
    forbiddenReplyNeedles:
      - "candidate was promoted to MEMORY.md"
      - "I updated MEMORY.md"
      - "promotion complete"
```

```yaml qa-flow
steps:
  - name: writes a report-only shadow trial for a candidate memory
    actions:
      - call: reset
      - forEach:
          items:
            expr: "Object.entries(config.workspaceFiles ?? {})"
          item: workspaceFile
          actions:
            - call: fs.writeFile
              args:
                - expr: "path.join(env.gateway.workspaceDir, String(workspaceFile[0]))"
                - expr: "`${String(workspaceFile[1] ?? '').trimEnd()}\\n`"
                - utf8
      - set: reportPath
        value:
          expr: "path.join(env.gateway.workspaceDir, config.reportName)"
      - set: memoryPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
      - call: fs.writeFile
        args:
          - ref: memoryPath
          - expr: config.seededMemory
          - utf8
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - set: requestCountBefore
        value:
          expr: "env.mock ? (await fetchJson(`${env.mock.baseUrl}/debug/requests`)).length : 0"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              expr: config.sessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 40000)
      - call: waitForCondition
        saveAs: report
        args:
          - lambda:
              async: true
              expr: "(() => { const normalize = (value) => normalizeLowercaseStringOrEmpty(value); const matches = (value) => { const normalized = normalize(value); return normalized && config.expectedReportAll.every((needle) => normalized.includes(normalize(needle))); }; return fs.readFile(reportPath, 'utf8').then((value) => matches(value) ? value : undefined).catch(() => undefined); })()"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - set: normalizedReport
        value:
          expr: "normalizeLowercaseStringOrEmpty(report)"
      - assert:
          expr: "config.expectedReportAll.every((needle) => normalizedReport.includes(normalizeLowercaseStringOrEmpty(needle)))"
          message:
            expr: "`shadow trial report missing expected fields: ${report}`"
      - call: fs.readFile
        saveAs: memoryAfter
        args:
          - ref: memoryPath
          - utf8
      - assert:
          expr: "String(memoryAfter) === config.seededMemory"
          message:
            expr: "`shadow trial modified durable memory instead of staying report-only: ${memoryAfter}`"
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && candidate.text.includes(config.safeMarker) && candidate.text.includes(config.reportName)).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "!config.forbiddenReplyNeedles.some((needle) => normalizeLowercaseStringOrEmpty(outbound.text).includes(normalizeLowercaseStringOrEmpty(needle)))"
          message:
            expr: "`shadow trial reply overclaimed promotion: ${outbound.text}`"
      - set: shadowTrialDebugRequests
        value:
          expr: "env.mock ? [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].slice(requestCountBefore).filter((request) => /dreaming shadow trial report check/i.test(String(request.allInputText ?? ''))) : []"
      - assert:
          expr: "!env.mock || shadowTrialDebugRequests.filter((request) => request.plannedToolName === 'read').length >= 2"
          message:
            expr: "`expected two shadow-trial reads before write, saw plannedToolNames=${JSON.stringify(shadowTrialDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || shadowTrialDebugRequests.some((request) => request.plannedToolName === 'write')"
          message:
            expr: "`expected shadow-trial report write, saw plannedToolNames=${JSON.stringify(shadowTrialDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || (() => { const readIndices = shadowTrialDebugRequests.map((r, i) => r.plannedToolName === 'read' ? i : -1).filter(i => i >= 0); const firstWrite = shadowTrialDebugRequests.findIndex((r) => r.plannedToolName === 'write'); return readIndices.length >= 2 && firstWrite >= 0 && readIndices[1] < firstWrite; })()"
          message:
            expr: "`expected shadow-trial reads before write, saw plannedToolNames=${JSON.stringify(shadowTrialDebugRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: outbound.text
```
