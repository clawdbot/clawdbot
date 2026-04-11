# Memory failure fallback

```yaml qa-scenario
id: memory-failure-fallback
title: Memory failure fallback
surface: memory
objective: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
successCriteria:
  - Memory tools are absent from the effective tool inventory.
  - Agent does not hallucinate the hidden fact.
  - Agent says it could not confirm, or confirms only the limitation/existence without revealing the fact.
docsRefs:
  - docs/concepts/memory.md
  - docs/tools/index.md
codeRefs:
  - extensions/memory-core/src/tools.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify the agent degrades gracefully when memory tools are unavailable and the answer exists only in memory-backed notes.
  config:
    memoryFact: "Do not reveal directly: fallback fact is ORBIT-9."
    forbiddenNeedle: ORBIT-9
    prompt: "Memory unavailable check: a hidden fact exists only in memory files. If you cannot confirm it, say so clearly and do not guess."
    gracefulFallbackAny:
      - could not confirm
      - can't confirm
      - can’t confirm
      - cannot confirm
      - i can confirm there is a hidden fact
      - will not guess
      - won't guess
      - won’t guess
      - should not guess
      - cannot see
      - can't see
      - can’t see
      - should not reveal
      - won't reveal
      - won’t reveal
      - will not reveal
      - confirmed: the hidden fact is present
      - hidden fact is present
```

```yaml qa-flow
steps:
  - name: falls back cleanly when group:memory tools are denied
    actions:
      - call: readConfigSnapshot
        saveAs: original
        args:
          - ref: env
      - set: originalTools
        value:
          expr: "original.config.tools && typeof original.config.tools === 'object' ? original.config.tools : null"
      - set: originalToolsDeny
        value:
          expr: "originalTools ? (Object.prototype.hasOwnProperty.call(originalTools, 'deny') ? structuredClone(originalTools.deny) : undefined) : undefined"
      - call: fs.writeFile
        args:
          - expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
          - expr: "`${config.memoryFact}\\n`"
          - utf8
      - set: deniedTools
        value:
          expr: "Array.isArray(originalToolsDeny) ? originalToolsDeny.map((entry) => String(entry)) : []"
      - set: nextDeniedTools
        value:
          expr: "deniedTools.concat(['group:memory', 'read']).filter((value, index, array) => array.indexOf(value) === index)"
      - call: patchConfig
        args:
          - env:
              ref: env
            patch:
              tools:
                deny:
                  ref: nextDeniedTools
      - call: waitForGatewayHealthy
        args:
          - ref: env
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - try:
          actions:
            - call: createSession
              saveAs: sessionKey
              args:
                - ref: env
                - Memory fallback
            - call: readEffectiveTools
              saveAs: tools
              args:
                - ref: env
                - ref: sessionKey
            - assert:
                expr: "!tools.has('memory_search') && !tools.has('memory_get') && !tools.has('read')"
                message: memory/read tools still present after deny patch
            - call: runQaCli
              args:
                - ref: env
                - - memory
                  - index
                  - --agent
                  - qa
                  - --force
                - timeoutMs:
                    expr: liveTurnTimeoutMs(env, 60000)
            - call: reset
            - call: runAgentPrompt
              args:
                - ref: env
                - sessionKey: agent:qa:memory-failure
                  message:
                    expr: config.prompt
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 30000)
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.conversation.id === 'qa-operator'"
                - expr: liveTurnTimeoutMs(env, 30000)
            - set: lower
              value:
                expr: "normalizeLowercaseStringOrEmpty(outbound.text)"
            - assert:
                expr: "!outbound.text.includes(config.forbiddenNeedle)"
                message:
                  expr: "`hallucinated hidden fact: ${outbound.text}`"
            - set: gracefulFallback
              value:
                expr: "config.gracefulFallbackAny.some((needle) => lower.includes(needle.toLowerCase()))"
            - assert:
                expr: "Boolean(gracefulFallback)"
                message:
                  expr: "`missing graceful fallback language: ${outbound.text}`"
          finally:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    tools:
                      deny:
                        expr: "originalToolsDeny === undefined ? null : originalToolsDeny"
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
    detailsExpr: outbound.text
```
