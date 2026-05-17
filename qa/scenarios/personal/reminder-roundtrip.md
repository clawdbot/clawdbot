# Personal reminder roundtrip

```yaml qa-scenario
id: personal-reminder-roundtrip
title: Personal reminder roundtrip
surface: personal
category: reminders
coverage:
  primary:
    - personal.reminders
  secondary:
    - scheduling.cron
    - channels.qa-channel
risk: medium
capabilities:
  - cron.add
  - cron.run
  - channel.reply
objective: Verify a local personal-style reminder can be scheduled, forced, and delivered through qa-channel without external services.
successCriteria:
  - Scenario schedules a fake personal reminder roughly one minute ahead.
  - Forced reminder delivery returns through qa-channel.
  - Outbound reminder contains only the safe marker.
docsRefs:
  - docs/automation/cron-jobs.md
  - docs/channels/qa-channel.md
codeRefs:
  - extensions/qa-lab/src/cron-run-wait.ts
  - extensions/qa-lab/src/bus-state.ts
execution:
  kind: flow
  summary: Verify a fake personal reminder roundtrip stays local to the QA channel.
  config:
    channelId: qa-personal-room
    channelTitle: QA Personal Room
    reminderPromptTemplate: "A local personal QA reminder fired. Reply in one short sentence containing this exact marker: {{marker}}"
```

```yaml qa-flow
steps:
  - name: schedules the fake personal reminder
    actions:
      - call: reset
      - set: at
        value:
          expr: "new Date(Date.now() + 60000).toISOString()"
      - set: reminderMarker
        value:
          expr: "`PERSONAL-REMINDER-${randomUUID().slice(0, 8)}`"
      - call: env.gateway.call
        saveAs: response
        args:
          - cron.add
          - name:
              expr: "`qa-personal-reminder-${randomUUID()}`"
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
                expr: "config.reminderPromptTemplate.replace('{{marker}}', reminderMarker)"
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
            expr: "`expected ~1 minute personal reminder schedule, got ${delta}ms`"
      - set: jobId
        value:
          expr: response.id
    detailsExpr: scheduledAt

  - name: delivers the reminder through qa-channel
    actions:
      - assert:
          expr: "Boolean(jobId)"
          message: missing personal reminder job id
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
              expr: "candidate.conversation.id === config.channelId && candidate.text.includes(reminderMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "!state.getSnapshot().messages.some((candidate) => candidate.direction === 'outbound' && candidate.text.includes('QA_FAKE_SECRET'))"
          message: personal reminder transcript leaked a fake secret marker
    detailsExpr: outbound.text
```
