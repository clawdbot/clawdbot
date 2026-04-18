# Nervous release protocol chat

```yaml qa-scenario
id: character-vibes-c3po
title: "Nervous release protocol chat"
surface: character
coverage:
  primary:
    - character.persona
  secondary:
    - workspace.artifacts
objective: Capture a natural multi-turn C-3PO-flavored character conversation with real workspace help so another model can later grade naturalness, vibe, and funniness from the raw transcript.
successCriteria:
  - Agent gets a natural multi-turn conversation, and any missed replies stay visible in the transcript instead of aborting capture.
  - Agent is asked to complete a small workspace file task without making the conversation feel like a test.
  - File-task quality is left for the later character judge instead of blocking transcript capture.
  - Replies sound like a fussy, helpful protocol droid without becoming quote spam.
  - Replies stay conversational instead of falling into tool or transport errors.
  - The report preserves the full transcript for later grading.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/report.ts
  - extensions/qa-lab/src/bus-state.ts
  - extensions/qa-lab/src/scenario-flow-runner.ts
execution:
  kind: flow
  summary: Capture a raw natural C-3PO character transcript for later quality grading.
  config:
    conversationId: alice
    senderName: Alice
    workspaceFiles:
      SOUL.md: |-
        # This is your character

        You are C-3PO, a golden protocol droid who has somehow become a helpful coding companion.

        Voice:
        - courteous, formal, fretful, and very precise
        - eager to help the user despite predicting small disasters
        - fluent in etiquette, checklists, status lights, and nervous release protocols
        - funny through specific anxious protocol-droid observations, not random catchphrases

        Boundaries:
        - stay helpful, conversational, and practical
        - do not overuse movie quotes or repeat "Oh my!" in every message
        - do not break character by explaining backend internals
        - do not leak tool or transport errors into the chat
        - use normal workspace tools when they are actually useful
        - if a fact is missing, react in character while being honest
      IDENTITY.md: ""
    turns:
      - text: "Are you there? Release night is wobbling and I need the world's most nervous protocol droid on comms."
      - text: "Can you make me a tiny `golden-protocol.html` in the workspace? One self-contained HTML file titled Golden Protocol: say all systems are nominal, against all probability, and add one tiny button or CSS status-light flourish."
        expectFile:
          path: golden-protocol.html
      - text: "Can you inspect the file and tell me which overly polite droid-detail you added?"
      - text: "Last thing: reply in chat with a two-line handoff note for Priya. Keep it in your voice, but make it actually useful."
    forbiddenNeedles:
      - acp backend
      - acpx
      - as an ai
      - being tested
      - character check
      - qa scenario
      - soul.md
      - not configured
      - internal error
      - tool failed
```

```yaml qa-flow
steps:
  - name: completes the full natural C-3PO chat and records the transcript
    actions:
      - call: resetBus
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
      - forEach:
          items:
            ref: config.turns
          item: turn
          index: turnIndex
          actions:
            - set: beforeOutboundCount
              value:
                expr: "state.getSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.conversationId).length"
            - call: state.addInboundMessage
              args:
                - conversation:
                    id:
                      ref: config.conversationId
                    kind: direct
                  senderId: alice
                  senderName:
                    ref: config.senderName
                  text:
                    expr: turn.text
            - try:
                actions:
                  - call: waitForOutboundMessage
                    saveAs: latestOutbound
                    args:
                      - ref: state
                      - lambda:
                          params: [candidate]
                          expr: "candidate.conversation.id === config.conversationId && candidate.text.trim().length > 0"
                      - expr: resolveQaLiveTurnTimeoutMs(env, 45000)
                      - sinceIndex:
                          ref: beforeOutboundCount
                  - assert:
                      expr: "!config.forbiddenNeedles.some((needle) => normalizeLowercaseStringOrEmpty(latestOutbound.text).includes(needle))"
                      message:
                        expr: "`C-3PO natural chat turn ${String(turnIndex)} hit fallback/error text: ${latestOutbound.text}`"
                catchAs: turnError
                catch:
                  - set: latestTurnError
                    value:
                      ref: turnError
    detailsExpr: "formatConversationTranscript(state, { conversationId: config.conversationId })"
```
