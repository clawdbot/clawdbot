# Subagent stale child links

```yaml qa-scenario
id: subagent-stale-child-links
title: Subagent stale child links
surface: subagents
coverage:
  primary:
    - agents.subagents
  secondary:
    - gateway.sessions-list
objective: Verify restarted gateways hide stale persisted subagent child links without hiding live or fresh children.
successCriteria:
  - Old ended subagent run records are not exposed as current children.
  - Old store-only spawnedBy and parentSessionKey rows are not exposed as current children.
  - Child-side ACP store rows from sibling agents are not exposed as current children.
  - Live subagent runs and fresh dashboard children remain visible.
docsRefs:
  - docs/tools/subagents.md
  - docs/concepts/qa-e2e-automation.md
  - docs/help/testing.md
codeRefs:
  - src/gateway/session-utils.ts
  - src/agents/subagent-run-liveness.ts
  - extensions/qa-lab/src/gateway-child.ts
execution:
  kind: flow
  summary: Seed stale subagent session state on disk, restart the real gateway, then assert sessions.list filters only the stale child links.
```

```yaml qa-flow
steps:
  - name: restarted gateway filters stale subagent child links
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - set: mainKey
        value: "agent:qa:main"
      - set: staleRunKey
        value: "agent:qa:subagent:qa-stale-ended"
      - set: staleOrphanKey
        value: "agent:qa:subagent:qa-orphan"
      - set: staleAcpKey
        value: "agent:claude:acp:qa-stale-acp"
      - set: freshDashboardKey
        value: "agent:qa:dashboard:qa-fresh-child"
      - set: liveRunKey
        value: "agent:qa:subagent:qa-live-child"
      - call: env.gateway.restartAfterStateMutation
        args:
          - lambda:
              params:
                - ctx
              async: true
              expr: |-
                await (async () => {
                  const now = Date.now();
                  const old = now - 2 * 60 * 60 * 1000;
                  const recent = now - 5000;
                  const qaSessionsDir = path.join(ctx.stateDir, "agents", "qa", "sessions");
                  const claudeSessionsDir = path.join(ctx.stateDir, "agents", "claude", "sessions");
                  const subagentDir = path.join(ctx.stateDir, "subagents");
                  await fs.mkdir(qaSessionsDir, { recursive: true });
                  await fs.mkdir(claudeSessionsDir, { recursive: true });
                  await fs.mkdir(subagentDir, { recursive: true });
                  await fs.writeFile(path.join(subagentDir, "runs.json"), `${JSON.stringify({
                    version: 2,
                    runs: {
                      "run-stale-ended": {
                        runId: "run-stale-ended",
                        childSessionKey: staleRunKey,
                        controllerSessionKey: mainKey,
                        requesterSessionKey: mainKey,
                        requesterDisplayKey: "main",
                        task: "old ended ghost",
                        cleanup: "keep",
                        createdAt: old - 60000,
                        startedAt: old - 50000,
                        endedAt: old,
                        outcome: { status: "ok" },
                      },
                      "run-live-visible": {
                        runId: "run-live-visible",
                        childSessionKey: liveRunKey,
                        controllerSessionKey: mainKey,
                        requesterSessionKey: mainKey,
                        requesterDisplayKey: "main",
                        task: "live child remains visible",
                        cleanup: "keep",
                        createdAt: recent,
                        startedAt: recent,
                      },
                    },
                  }, null, 2)}\n`, "utf8");
                  await fs.writeFile(path.join(qaSessionsDir, "sessions.json"), `${JSON.stringify({
                    [mainKey]: {
                      sessionId: "sess-main",
                      updatedAt: now,
                    },
                    [staleRunKey]: {
                      sessionId: "sess-stale-run",
                      updatedAt: old,
                      spawnedBy: mainKey,
                      status: "done",
                      endedAt: old,
                    },
                    [staleOrphanKey]: {
                      sessionId: "sess-orphan",
                      updatedAt: old,
                      parentSessionKey: mainKey,
                    },
                    [freshDashboardKey]: {
                      sessionId: "sess-fresh-dashboard",
                      updatedAt: now,
                      parentSessionKey: mainKey,
                    },
                    [liveRunKey]: {
                      sessionId: "sess-live-child",
                      updatedAt: recent,
                      spawnedBy: mainKey,
                    },
                  }, null, 2)}\n`, "utf8");
                  await fs.writeFile(path.join(claudeSessionsDir, "sessions.json"), `${JSON.stringify({
                    [staleAcpKey]: {
                      sessionId: "sess-acp-stale",
                      updatedAt: old,
                      spawnedBy: mainKey,
                      status: "done",
                      endedAt: old,
                    },
                  }, null, 2)}\n`, "utf8");
                })()
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: env.gateway.call
        saveAs: listed
        args:
          - "sessions.list"
          - {}
          - timeoutMs: 60000
      - call: env.gateway.call
        saveAs: filtered
        args:
          - "sessions.list"
          - spawnedBy:
              ref: mainKey
          - timeoutMs: 60000
      - set: mainChildren
        value:
          expr: "(listed.sessions.find((session) => session.key === mainKey)?.childSessions ?? [])"
      - set: filteredKeys
        value:
          expr: "filtered.sessions.map((session) => session.key)"
      - assert:
          expr: "mainChildren.includes(freshDashboardKey)"
          message:
            expr: "`fresh dashboard child missing from main children: ${JSON.stringify(mainChildren)}`"
      - assert:
          expr: "mainChildren.includes(liveRunKey)"
          message:
            expr: "`live subagent child missing from main children: ${JSON.stringify(mainChildren)}`"
      - assert:
          expr: "filteredKeys.includes(freshDashboardKey) && filteredKeys.includes(liveRunKey)"
          message:
            expr: "`spawnedBy filter dropped live/fresh children: ${JSON.stringify(filteredKeys)}`"
      - assert:
          expr: "![staleRunKey, staleOrphanKey, staleAcpKey].some((key) => mainChildren.includes(key) || filteredKeys.includes(key))"
          message:
            expr: "`stale child leaked through sessions.list (main=${JSON.stringify(mainChildren)} filtered=${JSON.stringify(filteredKeys)})`"
    detailsExpr: "({ mainChildren, filteredKeys })"
```
