# Cron one-minute ping

```yaml qa-scenario
id: cron-one-minute-ping
title: Cron one-minute ping
surface: cron
coverage:
  primary:
    - scheduling.cron
  secondary:
    - channels.qa-channel
objective: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
successCriteria:
  - Agent schedules a cron reminder roughly one minute ahead.
  - Reminder returns through qa-channel.
  - Agent recognizes the reminder as part of the original task.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/bus-server.ts
  - extensions/qa-lab/src/self-check.ts
execution:
  kind: flow
  summary: Verify the agent can schedule a cron reminder one minute in the future and receive the follow-up in the QA channel.
  config:
    channelId: qa-room
    channelTitle: QA Room
    reminderPromptTemplate: "A QA cron just fired. Send a one-line ping back to the room containing this exact marker: {{marker}}"
```

```yaml qa-flow
steps:
  - name: stores a reminder roughly one minute ahead
    actions:
      - call: reset
      - set: at
        value:
          expr: "new Date(Date.now() + 60000).toISOString()"
      - set: cronMarker
        value:
          expr: "`QA-CRON-${randomUUID().slice(0, 8)}`"
      - call: env.gateway.call
        saveAs: response
        args:
          - cron.add
          - name:
              expr: "`qa-suite-${randomUUID()}`"
            enabled: true
            schedule:
              kind: at
              at:
                ref: at
            sessionTarget: isolated
            wakeMode: now
            payload:
              kind: agentTurn
              message:
                expr: "config.reminderPromptTemplate.replace('{{marker}}', cronMarker)"
            delivery:
              mode: announce
              channel: qa-channel
              to:
                expr: "`channel:${config.channelId}`"
      - set: scheduledAt
        value:
          expr: "response.schedule?.at ?? at"
      - set: delta
        value:
          expr: "new Date(scheduledAt).getTime() - Date.now()"
      - assert:
          expr: "delta >= 45000 && delta <= 75000"
          message:
            expr: "`expected ~1 minute schedule, got ${delta}ms`"
      - set: jobId
        value:
          expr: response.id
    detailsExpr: scheduledAt

  - name: forces the reminder through QA channel delivery
    actions:
      - assert:
          expr: "Boolean(jobId)"
          message: missing cron job id
      - assert:
          expr: "Boolean(cronMarker)"
          message: missing cron marker
      - set: runStartedAt
        value:
          expr: "Date.now()"
      - call: env.gateway.call
        args:
          - cron.run
          - id:
              ref: jobId
            mode: force
          - timeoutMs: 30000
      - call: waitForCronRunCompletion
        args:
          - callGateway:
              expr: "env.gateway.call.bind(env.gateway)"
            jobId:
              ref: jobId
            afterTs:
              ref: runStartedAt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 45000)
      - call: waitForOutboundMessage
        saveAs: outbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId && candidate.text.includes(cronMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
    detailsExpr: outbound.text
```
