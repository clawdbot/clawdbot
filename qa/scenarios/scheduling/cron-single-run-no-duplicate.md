# Cron single run no duplicate

```yaml qa-scenario
id: cron-single-run-no-duplicate
title: Cron single run no duplicate
surface: cron
coverage:
  primary:
    - scheduling.cron
  secondary:
    - channels.qa-channel
    - scheduling.dedup
objective: Verify one forced cron run produces exactly one qa-channel delivery for its marker.
successCriteria:
  - A single forced cron run completes successfully.
  - The qa-channel receives exactly one outbound reply containing the run marker.
  - No second outbound reply with the same marker appears during the duplicate window.
docsRefs:
  - docs/help/testing.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/cron/service.ts
  - src/cron/run-log.ts
  - extensions/qa-lab/src/cron-run-wait.ts
  - extensions/qa-lab/src/suite-runtime-transport.ts
execution:
  kind: flow
  summary: Force one cron run and assert qa-channel does not receive a duplicate delivery for the same marker.
  config:
    channelId: qa-room
    channelTitle: QA Room
    duplicateWindowMs: 8000
    reminderPromptTemplate: "A QA cron dedupe check fired. Send a one-line ping back to the room containing this exact marker: {{marker}}"
```

```yaml qa-flow
steps:
  - name: creates a future cron job and forces one run
    actions:
      - call: reset
      - set: scheduledFor
        value:
          expr: "new Date(Date.now() + 10 * 60 * 1000).toISOString()"
      - set: cronMarker
        value:
          expr: "`QA-CRON-DEDUPE-${randomUUID().slice(0, 8)}`"
      - call: env.gateway.call
        saveAs: response
        args:
          - cron.add
          - name:
              expr: "`qa-dedupe-${randomUUID()}`"
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
      - set: jobId
        value:
          expr: response.id
      - assert:
          expr: "Boolean(jobId)"
          message: missing cron job id
      - set: runStartedAt
        value:
          expr: "Date.now()"
      - call: env.gateway.call
        saveAs: runResponse
        args:
          - cron.run
          - id:
              ref: jobId
            mode: force
          - timeoutMs: 30000
      - assert:
          expr: "runResponse?.ok === true && runResponse?.ran !== false"
          message:
            expr: "`expected cron.run to enqueue one run, got ${JSON.stringify(runResponse)}`"
    detailsExpr: "`job=${jobId} marker=${cronMarker}`"

  - name: observes exactly one qa-channel delivery for that run
    actions:
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
              expr: liveTurnTimeoutMs(env, 45000)
      - assert:
          expr: "completedRun?.status === 'ok'"
          message:
            expr: "`expected cron run ok, got ${JSON.stringify(completedRun)}`"
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
            expr: "`expected one outbound delivery for ${cronMarker}, saw ${duplicateMatches.length}: ${duplicateMatches.map((message) => message.text).join(' | ')}`"
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
            expr: "`expected one completed cron run for ${jobId}, saw ${completedRuns.length}: ${JSON.stringify(completedRuns)}`"
    detailsExpr: "`first outbound=${firstOutboundId}; duplicate window=${config.duplicateWindowMs}ms`"
```
