# Reaction, edit, delete lifecycle

```yaml qa-scenario
id: reaction-edit-delete
title: Reaction, edit, delete lifecycle
surface: message-actions
coverage:
  primary:
    - channels.message-actions
  secondary:
    - channels.qa-channel
objective: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
successCriteria:
  - Agent adds at least one reaction.
  - Agent edits or replaces a message when asked.
  - Transcript shows the action lifecycle correctly.
docsRefs:
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-channel/src/channel-actions.ts
  - extensions/qa-lab/src/self-check-scenario.ts
execution:
  kind: flow
  summary: Verify the agent can use channel-owned message actions and that the QA transcript reflects them.
  config:
    target: "channel:qa-room"
    seedText: "seed message"
    editedText: "seed message (edited)"
    reactionEmoji: "white_check_mark"
```

```yaml qa-flow
steps:
  - name: records reaction, edit, and delete actions
    actions:
      - call: reset
      - call: state.addOutboundMessage
        saveAs: seed
        args:
          - to:
              expr: config.target
            text:
              expr: config.seedText
      - call: handleQaAction
        args:
          - env:
              ref: env
            action: react
            args:
              messageId:
                expr: seed.id
              emoji:
                expr: config.reactionEmoji
      - call: handleQaAction
        args:
          - env:
              ref: env
            action: edit
            args:
              messageId:
                expr: seed.id
              text:
                expr: config.editedText
      - call: handleQaAction
        args:
          - env:
              ref: env
            action: delete
            args:
              messageId:
                expr: seed.id
      - call: state.readMessage
        saveAs: message
        args:
          - messageId:
              expr: seed.id
      - assert:
          expr: "message.reactions.length > 0 && message.deleted && message.text.includes('(edited)')"
          message: message lifecycle did not persist
    detailsExpr: message.text
```
