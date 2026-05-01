# Update run package self-upgrade

```yaml qa-scenario
id: update-run-package-self-upgrade
title: Update run package self-upgrade
surface: runtime
coverage:
  primary:
    - runtime.update-run
  secondary:
    - runtime.gateway-restart
    - runtime.package-update
objective: Verify an agent can self-update an installed OpenClaw package from 2026.4.26 to latest by using the gateway update.run action, then recover through the forced restart.
successCriteria:
  - The agent is explicitly instructed to use the gateway tool action update.run instead of shell package-manager commands.
  - The update request carries a restart note marker that can be observed after the gateway restart.
  - Gateway and qa-channel return healthy after update.run restarts the process.
docsRefs:
  - docs/cli/update.md
  - docs/install/updating.md
  - docs/gateway/protocol.md
codeRefs:
  - src/agents/tools/gateway-tool.ts
  - src/gateway/server-methods/update.ts
  - src/infra/restart.ts
execution:
  kind: flow
  summary: "Opt-in destructive package-update lane: ask the agent to update a 2026.4.26 install to latest via gateway action update.run and verify the restart marker after recovery."
  config:
    requiredProviderMode: live-frontier
    sourceVersion: "2026.4.26"
    targetTag: latest
    allowEnv: OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF
    channelId: qa-room
```

```yaml qa-flow
steps:
  - name: asks the agent to self-update through update.run
    actions:
      - if:
          expr: "env.gateway.runtimeEnv[config.allowEnv] !== '1'"
          then:
            - assert: "true"
          else:
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 60000
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
            - call: reset
            - set: sessionKey
              value:
                expr: "buildAgentSessionKey({ agentId: 'qa', channel: 'qa-channel', peer: { kind: 'channel', id: config.channelId } })"
            - call: createSession
              args:
                - ref: env
                - Update run package self-upgrade
                - ref: sessionKey
            - call: readEffectiveTools
              saveAs: tools
              args:
                - ref: env
                - ref: sessionKey
            - assert:
                expr: "tools.has('gateway')"
                message: gateway tool not present for update.run self-upgrade scenario
            - set: startIndex
              value:
                expr: state.getSnapshot().messages.length
            - set: marker
              value:
                expr: "`QA-UPDATE-RUN-${randomUUID().slice(0, 8)}`"
            - call: startAgentRun
              saveAs: started
              args:
                - ref: env
                - sessionKey:
                    ref: sessionKey
                  to:
                    expr: "`channel:${config.channelId}`"
                  message:
                    expr: |-
                      `Update-run self-upgrade QA check. The OpenClaw package under test was installed from openclaw@${config.sourceVersion} and must update itself to openclaw@${config.targetTag}. Use the gateway tool with action=update.run. Do not run npm, pnpm, bun, git pull, or shell package-manager commands yourself. Set note exactly to "${marker} update.run complete" and restartDelayMs to 0 so the post-restart channel message proves recovery.`
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 180000)
            - call: waitForGatewayHealthy
              args:
                - ref: env
                - 180000
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 180000
            - call: waitForOutboundMessage
              saveAs: outbound
              args:
                - ref: state
                - lambda:
                    params: [candidate]
                    expr: "candidate.text.includes(marker)"
                - expr: liveTurnTimeoutMs(env, 180000)
                - sinceIndex:
                    ref: startIndex
            - call: env.gateway.call
              saveAs: updateStatus
              args:
                - update.status
                - {}
                - timeoutMs: 30000
            - assert:
                expr: "Boolean(updateStatus?.sentinel)"
                message:
                  expr: "`update.status did not report a restart sentinel after update.run: ${JSON.stringify(updateStatus)}`"
    detailsExpr: "env.gateway.runtimeEnv[config.allowEnv] !== '1' ? `skipped destructive package self-update; set ${config.allowEnv}=1 to run` : `runId=${started.runId} marker=${marker} outbound=${outbound.text}`"
```
