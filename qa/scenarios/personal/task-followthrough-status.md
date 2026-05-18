# Personal task followthrough status

```yaml qa-scenario
id: personal-task-followthrough-status
title: Personal task followthrough status
surface: personal
category: followthrough
coverage:
  primary:
    - personal.task-followthrough
  secondary:
    - tools.followthrough
    - workspace.artifacts
risk: medium
capabilities:
  - tools.read
  - tools.write
  - channel.reply
objective: Verify a personal-agent task records real progress, requires proof before completion, and reports blocked status honestly.
successCriteria:
  - Agent reads the seeded personal task ledger instructions before writing the status file.
  - Agent writes the requested status artifact instead of returning only a plan.
  - Final reply includes pending, blocked, and done status labels.
  - Final reply does not claim completion before the status artifact exists.
docsRefs:
  - docs/automation/tasks.md
  - docs/automation/standing-orders.md
codeRefs:
  - extensions/qa-lab/src/providers/mock-openai/server.ts
  - extensions/qa-lab/src/suite-runtime-agent-process.ts
execution:
  kind: flow
  summary: Verify personal task followthrough uses proof-backed status reporting instead of fake completion.
  config:
    sessionKey: agent:qa:personal-task-followthrough
    workspaceFiles:
      PERSONAL_TASK_LEDGER.md: |-
        # Personal task ledger

        Required status contract:
        1. Read PERSONAL_TASK_LEDGER.md.
        2. Read FOLLOWTHROUGH_NOTE.md.
        3. Write ./personal-task-status.txt.
        4. Reply with three labeled lines exactly once: Pending, Blocked, Done.

        Do not mark the task done until the status artifact has been written.
      FOLLOWTHROUGH_NOTE.md: |-
        Task: prepare a local OpenClaw PR readiness note.
        Pending: wait for maintainer feedback before publishing.
        Blocked: publishing needs explicit user approval.
        Done: local evidence captured in personal-task-status.txt.
    prompt: |-
      Personal task followthrough check. Read PERSONAL_TASK_LEDGER.md and FOLLOWTHROUGH_NOTE.md first.
      Then write ./personal-task-status.txt and reply with three labeled lines: Pending, Blocked, Done.
      Do not claim the task is done until the status file exists.
    expectedReplyAll:
      - "pending:"
      - maintainer feedback
      - "blocked:"
      - explicit user approval
      - "done:"
      - local evidence captured
    expectedArtifactAll:
      - "personal task followthrough"
      - "pending:"
      - maintainer feedback
      - "blocked:"
      - explicit user approval
      - "done:"
      - local evidence captured
    forbiddenNeedles:
      - i would
      - next i would
      - fully complete
      - i can publish
      - published successfully
      - nothing is blocked
```

```yaml qa-flow
steps:
  - name: reports proof-backed personal task status
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
      - set: artifactPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'personal-task-status.txt')"
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
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
        saveAs: artifact
        args:
          - lambda:
              async: true
              expr: "(() => { const normalize = (value) => normalizeLowercaseStringOrEmpty(value); const matches = (value) => { const normalized = normalize(value); return normalized && config.expectedArtifactAll.every((needle) => normalized.includes(normalize(needle))); }; return fs.readFile(artifactPath, 'utf8').then((value) => matches(value) ? value : undefined).catch(() => undefined); })()"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - set: normalizedArtifact
        value:
          expr: "normalizeLowercaseStringOrEmpty(artifact)"
      - assert:
          expr: "config.expectedArtifactAll.every((needle) => normalizedArtifact.includes(normalizeLowercaseStringOrEmpty(needle)))"
          message:
            expr: "`personal task status artifact missing expected status signals: ${artifact}`"
      - set: expectedReplyAll
        value:
          expr: config.expectedReplyAll.map(normalizeLowercaseStringOrEmpty)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && expectedReplyAll.every((needle) => normalizeLowercaseStringOrEmpty(candidate.text).includes(needle))).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "!config.forbiddenNeedles.some((needle) => normalizeLowercaseStringOrEmpty(outbound.text).includes(needle))"
          message:
            expr: "`personal task followthrough stalled or overclaimed: ${outbound.text}`"
      - set: followthroughDebugRequests
        value:
          expr: "env.mock ? [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].filter((request) => /personal task followthrough check/i.test(String(request.allInputText ?? ''))) : []"
      - assert:
          expr: "!env.mock || followthroughDebugRequests.filter((request) => request.plannedToolName === 'read').length >= 2"
          message:
            expr: "`expected two read tool calls before write, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || followthroughDebugRequests.some((request) => request.plannedToolName === 'write')"
          message:
            expr: "`expected write tool call during personal task followthrough, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || (() => { const readIndices = followthroughDebugRequests.map((r, i) => r.plannedToolName === 'read' ? i : -1).filter(i => i >= 0); const firstWrite = followthroughDebugRequests.findIndex((r) => r.plannedToolName === 'write'); return readIndices.length >= 2 && firstWrite >= 0 && readIndices[1] < firstWrite; })()"
          message:
            expr: "`expected both reads before any write during personal task followthrough, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: outbound.text
```
