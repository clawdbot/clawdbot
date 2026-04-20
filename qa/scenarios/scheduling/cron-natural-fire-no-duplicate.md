# Cron natural fire no duplicate

```yaml qa-scenario
id: cron-natural-fire-no-duplicate
title: Cron natural fire no duplicate
surface: cron
coverage:
  primary:
    - scheduling.cron
  secondary:
    - channels.qa-channel
    - scheduling.dedup
objective: Verify one naturally fired cron run in a single gateway uptime produces exactly one qa-channel delivery for its marker.
successCriteria:
  - A one-shot cron job fires from the scheduler timer without cron.run force mode.
  - The qa-channel receives exactly one outbound reply containing the run marker.
  - No second outbound reply with the same marker appears during the duplicate window.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/cron/service.ts
  - src/cron/service/timer.ts
  - src/cron/run-log.ts
  - extensions/qa-lab/src/cron-run-wait.ts
  - extensions/qa-lab/src/suite-runtime-transport.ts
execution:
  kind: flow
  summary: Let one cron job fire from the natural scheduler timer and assert qa-channel does not receive a duplicate delivery for the same marker.
  config:
    channelId: qa-room
    channelTitle: QA Room
    fireDelayMs: 12000
    duplicateWindowMs: 8000
    reminderPromptTemplate: "A natural QA cron dedupe check fired. Send a one-line ping back to the room containing this exact marker: {{marker}}"
```

```yaml qa-flow
steps:
  - name: creates a near-future cron job and waits for the scheduler timer
    actions:
      - call: reset
      - set: runStartedAt
        value:
          expr: "Date.now()"
      - set: scheduledFor
        value:
          expr: "new Date(runStartedAt + config.fireDelayMs).toISOString()"
      - set: cronMarker
        value:
          expr: "`QA-CRON-NATURAL-DEDUPE-${randomUUID().slice(0, 8)}`"
      - call: env.gateway.call
        saveAs: response
        args:
          - cron.add
          - name:
              expr: "`qa-natural-dedupe-${randomUUID()}`"
            enabled: true
            schedule:
              kind: at
              at:
                ref: scheduledFor
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
          - timeoutMs: 30000
      - set: jobId
        value:
          expr: response.id
      - assert:
          expr: "Boolean(jobId)"
          message: missing cron job id
      - set: scheduledAtMs
        value:
          expr: "new Date(response.schedule?.at ?? scheduledFor).getTime()"
      - set: scheduleDeltaMs
        value:
          expr: "scheduledAtMs - runStartedAt"
      - assert:
          expr: "scheduleDeltaMs >= config.fireDelayMs - 2000 && scheduleDeltaMs <= config.fireDelayMs + 5000"
          message:
            expr: "`expected near-future natural fire, got ${scheduleDeltaMs}ms`"
      - call: waitForCronRunCompletion
        saveAs: completedRun
        args:
          - callGateway:
              expr: "env.gateway.call.bind(env.gateway)"
            jobId:
              ref: jobId
            afterTs:
              ref: runStartedAt
            timeoutMs:
              expr: "liveTurnTimeoutMs(env, Math.max(60000, config.fireDelayMs + 45000))"
      - assert:
          expr: "Date.now() >= scheduledAtMs"
          message:
            expr: "`cron completed before scheduled time ${scheduledFor}`"
      - assert:
          expr: "completedRun?.status === 'ok'"
          message:
            expr: "`expected natural cron run ok, got ${JSON.stringify(completedRun)}`"
    detailsExpr: "`job=${jobId} marker=${cronMarker} scheduled=${scheduledFor}`"

  - name: observes exactly one qa-channel delivery for the natural run
    actions:
      - call: waitForOutboundMessage
        saveAs: firstOutbound
        args:
          - ref: state
          - lambda:
              params: [candidate]
              expr: "candidate.conversation.id === config.channelId && candidate.text.includes(cronMarker)"
          - expr: liveTurnTimeoutMs(env, 45000)
      - set: firstOutboundId
        value:
          expr: firstOutbound.id
      - set: firstOutboundIndex
        value:
          expr: "getTransportSnapshot().messages.findIndex((message) => message.id === firstOutboundId)"
      - assert:
          expr: "firstOutboundIndex >= 0"
          message: first outbound message missing from qa-channel snapshot
      - call: sleep
        args:
          - expr: config.duplicateWindowMs
      - set: duplicateMatches
        value:
          expr: "getTransportSnapshot().messages.filter((message) => message.direction === 'outbound' && message.conversation.id === config.channelId && message.text.includes(cronMarker))"
      - assert:
          expr: "duplicateMatches.length === 1"
          message:
            expr: "`expected one natural outbound delivery for ${cronMarker}, saw ${duplicateMatches.length}: ${duplicateMatches.map((message) => message.text).join(' | ')}`"
      - call: env.gateway.call
        saveAs: runsPage
        args:
          - cron.runs
          - id:
              ref: jobId
            limit: 10
            sortDir: desc
          - timeoutMs: 30000
      - set: completedRuns
        value:
          expr: "runsPage.entries.filter((entry) => entry.ts >= runStartedAt && ['ok', 'error', 'skipped'].includes(entry.status))"
      - assert:
          expr: "completedRuns.length === 1"
          message:
            expr: "`expected one completed natural cron run for ${jobId}, saw ${completedRuns.length}: ${JSON.stringify(completedRuns)}`"
    detailsExpr: "`first outbound=${firstOutboundId}; duplicate window=${config.duplicateWindowMs}ms`"
```
