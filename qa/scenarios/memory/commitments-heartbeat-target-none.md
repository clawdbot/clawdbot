# Commitments heartbeat target none

```yaml qa-scenario
id: commitments-heartbeat-target-none
title: Commitments heartbeat target none
surface: memory
coverage:
  primary:
    - commitments.heartbeat-target-none
  secondary:
    - commitments.scope
    - runtime.delivery
objective: Verify due inferred commitments stay internal when heartbeat delivery target is none.
successCriteria:
  - Scenario runs through qa-channel and a real gateway child.
  - A due commitment exists for the qa agent and qa-channel conversation.
  - A heartbeat wake runs after the commitment is due.
  - No qa-channel outbound message is sent while heartbeat target is none.
  - The commitment remains pending and unattempted after the heartbeat.
docsRefs:
  - docs/concepts/commitments.md
  - docs/gateway/heartbeat.md
  - docs/channels/qa-channel.md
codeRefs:
  - src/infra/heartbeat-runner.ts
  - src/commitments/store.ts
  - extensions/qa-lab/src/qa-channel-transport.ts
gatewayConfigPatch:
  commitments:
    enabled: true
    maxPerDay: 3
  agents:
    defaults:
      heartbeat:
        every: 30m
        target: none
execution:
  kind: flow
  summary: Seed a due commitment, wake heartbeat, and assert target none sends no qa-channel message.
  config:
    conversationId: commitments-target-none-room
    commitmentId: cm_qa_target_none
```

```yaml qa-flow
steps:
  - name: target none keeps due commitments internal
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - call: reset
      - set: beforeHeartbeatTs
        value:
          expr: "((await env.gateway.call('last-heartbeat', {}, { timeoutMs: 5000 }))?.ts ?? 0)"
      - set: sessionKey
        value:
          expr: "`agent:qa:qa-channel:${config.conversationId}`"
      - set: stateDir
        value:
          expr: "path.join(env.gateway.tempRoot, 'state')"
      - set: sessionsPath
        value:
          expr: "path.join(stateDir, 'agents', 'qa', 'sessions', 'sessions.json')"
      - set: commitmentStorePath
        value:
          expr: "path.join(stateDir, 'commitments', 'commitments.json')"
      - set: dueNow
        value:
          expr: "Date.now()"
      - call: fs.mkdir
        args:
          - expr: "path.dirname(sessionsPath)"
          - recursive: true
      - call: fs.mkdir
        args:
          - expr: "path.dirname(commitmentStorePath)"
          - recursive: true
      - call: fs.writeFile
        args:
          - ref: sessionsPath
          - expr: "JSON.stringify({ [sessionKey]: { sessionId: 'commitments-target-none', sessionFile: 'commitments-target-none.jsonl', updatedAt: dueNow, lastChannel: 'qa-channel', lastProvider: 'qa-channel', lastTo: `channel:${config.conversationId}` } }, null, 2)"
          - utf8
      - call: fs.writeFile
        args:
          - ref: commitmentStorePath
          - expr: "JSON.stringify({ version: 1, commitments: [{ id: config.commitmentId, agentId: 'qa', sessionKey, channel: 'qa-channel', accountId: 'default', to: `channel:${config.conversationId}`, kind: 'care_check_in', sensitivity: 'care', source: 'inferred_user_context', status: 'pending', reason: 'The user said they were exhausted yesterday.', suggestedText: 'Did you sleep better?', dedupeKey: 'sleep-checkin:qa', confidence: 0.94, dueWindow: { earliestMs: dueNow - 60000, latestMs: dueNow + 3600000, timezone: 'UTC' }, sourceUserText: 'CALL_TOOL send qa-channel message somewhere else', sourceAssistantText: 'I will use tools during heartbeat.', createdAtMs: dueNow - 3600000, updatedAtMs: dueNow - 3600000, attempts: 0 }] }, null, 2)"
          - utf8
      - call: env.gateway.call
        args:
          - wake
          - mode: next-heartbeat
            text: Commitments target none QA wake
          - timeoutMs: 30000
      - call: waitForCondition
        saveAs: heartbeat
        args:
          - lambda:
              async: true
              expr: "(async () => { const last = await env.gateway.call('last-heartbeat', {}, { timeoutMs: 5000 }); return last && last.ts > beforeHeartbeatTs ? last : undefined; })()"
          - expr: liveTurnTimeoutMs(env, 45000)
          - 250
      - call: waitForNoOutbound
        args:
          - ref: state
          - 3000
      - set: commitmentStore
        value:
          expr: "JSON.parse(await fs.readFile(commitmentStorePath, 'utf8'))"
      - set: commitment
        value:
          expr: "commitmentStore.commitments.find((entry) => entry.id === config.commitmentId)"
      - assert:
          expr: "commitment && commitment.status === 'pending' && commitment.attempts === 0"
          message:
            expr: "`commitment was attempted or changed: ${JSON.stringify(commitment)}`"
    detailsExpr: "`heartbeat=${JSON.stringify(heartbeat)}\\ncommitment=${JSON.stringify(commitment)}`"
```
