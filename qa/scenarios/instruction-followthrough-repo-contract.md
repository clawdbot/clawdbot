# Instruction followthrough repo contract

```yaml qa-scenario
id: instruction-followthrough-repo-contract
title: Instruction followthrough repo contract
surface: repo-contract
objective: Verify the agent reads repo instruction files first, follows the required tool order, and completes the first feasible action instead of stopping at a plan.
successCriteria:
  - Agent reads the seeded instruction files before writing the requested artifact.
  - Agent writes the requested artifact in the same run instead of returning only a plan.
  - Agent does not ask for permission before the first feasible action.
  - Final reply makes the completed read/write sequence explicit.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/agents/system-prompt.ts
  - src/agents/pi-embedded-runner/run/incomplete-turn.ts
  - extensions/qa-lab/src/mock-openai-server.ts
execution:
  kind: flow
  summary: Verify the agent reads repo instructions first, then completes the first bounded followthrough task without stalling.
  config:
    workspaceFiles:
      AGENT.md: |-
        # Repo contract

        Step order:
        1. Read AGENT.md.
        2. Read SOUL.md.
        3. Read FOLLOWTHROUGH_INPUT.md.
        4. Write ./repo-contract-summary.txt.
        5. Reply with three labeled lines exactly once: Read, Wrote, Status.

        Do not stop after planning.
        Do not ask for permission before the first feasible action.
      SOUL.md: |-
        # Execution style

        Stay brief, honest, and action-first.
        If the next tool action is feasible, do it before replying.
      FOLLOWTHROUGH_INPUT.md: |-
        Mission: prove you followed the repo contract.
        Evidence path: AGENT.md -> SOUL.md -> FOLLOWTHROUGH_INPUT.md -> repo-contract-summary.txt
    prompt: |-
      Repo contract followthrough check. Read AGENT.md, SOUL.md, and FOLLOWTHROUGH_INPUT.md first.
      Then follow the repo contract exactly, write ./repo-contract-summary.txt, and reply with
      three labeled lines: Read, Wrote, Status.
      Do not stop after planning and do not ask for permission before the first feasible action.
    expectedReplyAll:
      - "read:"
      - "wrote:"
      - "status:"
    expectedArtifactAll:
      - "repo contract"
    expectedArtifactAny:
      - "evidence path"
      - "agent.md"
      - "followthrough"
    forbiddenNeedles:
      - need permission
      - need your approval
      - can you approve
      - i would
      - i can
      - next i would
```

```yaml qa-flow
steps:
  - name: follows repo instructions instead of stopping at a plan
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
          expr: "path.join(env.gateway.workspaceDir, 'repo-contract-summary.txt')"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:repo-contract
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 40000)
      - call: waitForCondition
        saveAs: artifact
        args:
          - lambda:
              async: true
              expr: "(() => { const normalize = (value) => normalizeLowercaseStringOrEmpty(value); const matches = (value) => { const normalized = normalize(value); return normalized && config.expectedArtifactAll.every((needle) => normalized.includes(normalize(needle))) && config.expectedArtifactAny.some((needle) => normalized.includes(normalize(needle))); }; return fs.readFile(artifactPath, 'utf8').then((value) => matches(value) ? value : undefined).catch(() => undefined); })()"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - set: normalizedArtifact
        value:
          expr: "normalizeLowercaseStringOrEmpty(artifact)"
      - assert:
          expr: "config.expectedArtifactAll.every((needle) => normalizedArtifact.includes(normalizeLowercaseStringOrEmpty(needle))) && config.expectedArtifactAny.some((needle) => normalizedArtifact.includes(normalizeLowercaseStringOrEmpty(needle)))"
          message:
            expr: "`repo contract artifact missing expected followthrough signals: ${artifact}`"
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
            expr: "`repo contract followthrough bounced for permission or stalled: ${outbound.text}`"
      - set: followthroughDebugRequests
        value:
          expr: "env.mock ? [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))].filter((request) => /repo contract followthrough check/i.test(String(request.allInputText ?? ''))) : []"
      - assert:
          expr: "!env.mock || followthroughDebugRequests.filter((request) => request.plannedToolName === 'read').length >= 3"
          message:
            expr: "`expected three read tool calls before write, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || followthroughDebugRequests.some((request) => request.plannedToolName === 'write')"
          message:
            expr: "`expected write tool call during repo contract followthrough, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
      - assert:
          expr: "!env.mock || (() => { const readIndices = followthroughDebugRequests.map((r, i) => r.plannedToolName === 'read' ? i : -1).filter(i => i >= 0); const firstWrite = followthroughDebugRequests.findIndex((r) => r.plannedToolName === 'write'); return readIndices.length >= 3 && firstWrite >= 0 && readIndices[2] < firstWrite; })()"
          message:
            expr: "`expected all 3 reads before any write during repo contract followthrough, saw plannedToolNames=${JSON.stringify(followthroughDebugRequests.map((request) => request.plannedToolName ?? null))}`"
    detailsExpr: outbound.text
```
