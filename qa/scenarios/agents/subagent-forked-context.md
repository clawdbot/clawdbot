# Subagent forked context

```yaml qa-scenario
id: subagent-forked-context
title: Subagent forked context
surface: subagents
coverage:
  primary:
    - agents.subagents
objective: Verify the agent can choose forked subagent context when the child needs the current transcript.
successCriteria:
  - Agent launches a native subagent with context=fork.
  - Subagent uses the forked requester transcript to recover the visible code.
  - Subagent request remains bounded and does not switch to ACP.
  - User-visible output includes the delegated result and the visible code.
docsRefs:
  - docs/tools/subagents.md
  - docs/concepts/session-tool.md
codeRefs:
  - src/agents/tools/sessions-spawn-tool.ts
  - src/agents/subagent-spawn.ts
execution:
  kind: flow
  summary: Ask the agent to delegate work that depends on the current transcript and assert sessions_spawn carries context=fork.
  config:
    contextNeedle: FORKED-CONTEXT-ALPHA
    prompt: "Forked subagent context QA check. The visible code in this current conversation is FORKED-CONTEXT-ALPHA. Delegate to a native subagent to report the visible code from the requester transcript. Do not include the visible code in the child task text; the child must recover it from forked transcript context. Use forked context if the child needs the current transcript; otherwise it will not know the code. A spawn-accepted result is not the answer. Wait for the child completion, then make sure user-visible output includes the visible code."
```

```yaml qa-flow
steps:
  - name: forks current transcript context for the child
    actions:
      - call: reset
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:forked-context
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 90000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && String(candidate.text ?? '').includes(config.contextNeedle) && !normalizeLowercaseStringOrEmpty(candidate.text).includes('waiting')).at(-1)"
          - expr: liveTurnTimeoutMs(env, 45000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "env.mock || String(outbound.text ?? '').includes(config.contextNeedle)"
          message:
            expr: "`expected live final answer to include fork-only context code ${config.contextNeedle}, got: ${outbound.text}`"
      - set: forkDebugRequests
        value:
          expr: "env.mock ? [...(await fetchJson(`${env.mock.baseUrl}/debug/requests`))] : []"
      - assert:
          expr: "!env.mock || forkDebugRequests.some((request) => !request.toolOutput && /forked subagent context qa check/i.test(String(request.allInputText ?? '')) && request.plannedToolName === 'sessions_spawn' && (request.plannedToolArgs?.context === 'fork' || /context\\s*=\\s*fork/i.test(String(request.allInputText ?? ''))))"
          message:
            expr: "`expected sessions_spawn context=fork during forked context scenario, saw ${JSON.stringify(forkDebugRequests.map((request) => ({ plannedToolName: request.plannedToolName ?? null, plannedToolArgs: request.plannedToolArgs ?? null })))} `"
    detailsExpr: outbound.text
```
