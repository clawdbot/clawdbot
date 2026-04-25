# Memory dreaming sweep

```yaml qa-scenario
id: memory-dreaming-sweep
title: Memory dreaming sweep
surface: memory
coverage:
  primary:
    - memory.dreaming
objective: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
successCriteria:
  - Dreaming can be enabled and doctor.memory.status reports the managed sweep cron.
  - Repeated recall signals give the dreaming sweep real material to process.
  - A dreaming sweep writes Light Sleep and REM Sleep blocks, then promotes the canary into MEMORY.md.
docsRefs:
  - docs/concepts/dreaming.md
  - docs/reference/memory-config.md
  - docs/web/control-ui.md
codeRefs:
  - extensions/memory-core/src/dreaming.ts
  - extensions/memory-core/src/dreaming-phases.ts
  - src/gateway/server-methods/doctor.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Verify enabling dreaming creates the managed sweep, stages light and REM artifacts, and consolidates repeated recall signals into durable memory.
  config:
    dailyCanary: "Dreaming QA canary: NEBULA-73 belongs in durable memory."
    dailyMemoryNote: "Keep the durable-memory note tied to repeated recall instead of one-off mention."
    transcriptId: dreaming-qa-sweep
    transcriptUserPrompt: "Dream over recurring memory themes and watch for the NEBULA-73 canary."
    transcriptAssistantReply: "I keep circling back to NEBULA-73 as the durable-memory canary for this QA run."
    searchQueries:
      - "dreaming qa canary nebula-73"
      - "durable memory canary nebula 73"
      - "which canary belongs to the dreaming qa check"
    expectedNeedle: "NEBULA-73"
```

```yaml qa-flow
steps:
  - name: enables dreaming and registers the managed sweep cron
    actions:
      - call: readConfigSnapshot
        saveAs: original
        args:
          - ref: env
      - set: pluginEntries
        value:
          expr: "original.config.plugins && typeof original.config.plugins === 'object' ? original.config.plugins.entries : undefined"
      - set: memoryCoreEntry
        value:
          expr: "pluginEntries && typeof pluginEntries['memory-core'] === 'object' ? pluginEntries['memory-core'] : undefined"
      - set: memoryCoreConfig
        value:
          expr: "memoryCoreEntry && typeof memoryCoreEntry.config === 'object' ? memoryCoreEntry.config : undefined"
      - set: originalDreaming
        value:
          expr: "memoryCoreConfig?.dreaming"
      - call: patchConfig
        args:
          - env:
              ref: env
            patch:
              plugins:
                entries:
                  memory-core:
                    config:
                      dreaming:
                        enabled: true
                        phases:
                          deep:
                            minScore: 0
                            minRecallCount: 3
                            minUniqueQueries: 3
      - call: waitForGatewayHealthy
        args:
          - ref: env
      - call: waitForQaChannelReady
        args:
          - ref: env
          - 60000
      - try:
          actions:
            - call: waitForCondition
              saveAs: status
              args:
                - lambda:
                    async: true
                    expr: "(() => readDoctorMemoryStatus(env).then((payload) => payload.dreaming?.phases?.deep?.managedCronPresent === true ? payload : undefined))()"
                - 30000
                - 500
            - call: listCronJobs
              saveAs: jobs
              args:
                - ref: env
            - set: managed
              value:
                expr: "findManagedDreamingCronJob(jobs)"
            - assert:
                expr: "Boolean(managed?.id)"
                message: managed dreaming cron job missing after enablement
            - set: dreamingOriginal
              value:
                expr: "structuredClone(originalDreaming)"
            - set: dreamingCronId
              value:
                expr: "managed.id"
          catchAs: enableError
          catch:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    plugins:
                      entries:
                        memory-core:
                          config:
                            dreaming:
                              expr: "originalDreaming === undefined ? null : structuredClone(originalDreaming)"
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
            - throw:
                expr: enableError
    detailsExpr: "JSON.stringify({ enabled: status.dreaming?.enabled ?? false, managedCronPresent: status.dreaming?.phases?.deep?.managedCronPresent ?? false, nextRunAtMs: status.dreaming?.phases?.deep?.nextRunAtMs ?? null })"

  - name: runs the sweep after repeated recall signals and writes promotion artifacts
    actions:
      - assert:
          expr: "Boolean(dreamingCronId)"
          message: missing managed dreaming cron id
      - set: cronId
        value:
          ref: dreamingCronId
      - set: dreamingDay
        value:
          expr: "formatMemoryDreamingDay(Date.now())"
      - set: dailyPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'memory', `${dreamingDay}.md`)"
      - set: lightReportPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'memory', 'dreaming', 'light', `${dreamingDay}.md`)"
      - set: remReportPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'memory', 'dreaming', 'rem', `${dreamingDay}.md`)"
      - set: memoryPath
        value:
          expr: "path.join(env.gateway.workspaceDir, 'MEMORY.md')"
      - set: homeDir
        value:
          expr: "env.gateway.runtimeEnv.HOME ?? env.gateway.runtimeEnv.OPENCLAW_HOME ?? env.gateway.tempRoot"
      - set: sessionsDir
        value:
          expr: "resolveSessionTranscriptsDirForAgent('qa', env.gateway.runtimeEnv, () => homeDir)"
      - set: transcriptPath
        value:
          expr: "path.join(sessionsDir, `${config.transcriptId}.jsonl`)"
      - try:
          actions:
            - call: fs.mkdir
              args:
                - expr: "path.dirname(dailyPath)"
                - recursive: true
            - call: fs.mkdir
              args:
                - ref: sessionsDir
                - recursive: true
            - call: fs.writeFile
              args:
                - ref: dailyPath
                - expr: "[`# ${dreamingDay}`, '', `- ${config.dailyCanary}`, `- ${config.dailyMemoryNote}`].join('\\n') + '\\n'"
                - utf8
            - set: now
              value:
                expr: "Date.now()"
            - call: fs.writeFile
              args:
                - ref: transcriptPath
                - expr: "[JSON.stringify({ type: 'session', id: config.transcriptId, timestamp: new Date(now - 120000).toISOString() }), JSON.stringify({ type: 'message', message: { role: 'user', timestamp: new Date(now - 90000).toISOString(), content: [{ type: 'text', text: config.transcriptUserPrompt }] } }), JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: new Date(now - 60000).toISOString(), content: [{ type: 'text', text: config.transcriptAssistantReply }] } })].join('\\n') + '\\n'"
                - utf8
            - call: fs.rm
              args:
                - ref: memoryPath
                - force: true
            - call: forceMemoryIndex
              args:
                - env:
                    ref: env
                  query:
                    expr: "config.searchQueries[0]"
                  expectedNeedle:
                    expr: config.expectedNeedle
            - call: sleep
              args:
                - 1000
            - forEach:
                items:
                  expr: config.searchQueries
                item: query
                actions:
                  - call: runQaCli
                    saveAs: payload
                    args:
                      - ref: env
                      - - memory
                        - search
                        - --agent
                        - qa
                        - --json
                        - --query
                        - ref: query
                      - timeoutMs:
                          expr: liveTurnTimeoutMs(env, 60000)
                        json: true
                  - assert:
                      expr: "JSON.stringify(payload.results ?? []).includes(config.expectedNeedle)"
                      message:
                        expr: "`memory search missed dreaming canary for query: ${query}`"
            - set: cronRunStartedAt
              value:
                expr: "Date.now()"
            - call: env.gateway.call
              saveAs: cronRun
              args:
                - cron.run
                - id:
                    ref: cronId
                  mode: force
                - timeoutMs:
                    expr: liveTurnTimeoutMs(env, 30000)
            - assert:
                expr: "cronRun.enqueued === true && Boolean(cronRun.runId)"
                message:
                  expr: "`dreaming cron did not enqueue a background run: ${JSON.stringify(cronRun)}`"
            - call: waitForCronRunCompletion
              saveAs: finishedRun
              args:
                - callGateway:
                    expr: "(method, rpcParams, opts) => env.gateway.call(method, rpcParams, opts)"
                  jobId:
                    ref: cronId
                  afterTs:
                    ref: cronRunStartedAt
                  timeoutMs:
                    expr: liveTurnTimeoutMs(env, 180000)
            - assert:
                expr: "finishedRun.status === 'ok'"
                message:
                  expr: "`dreaming cron finished with ${finishedRun.status ?? 'unknown'}: ${JSON.stringify(finishedRun)}`"
            - call: waitForCondition
              saveAs: promoted
              args:
                - lambda:
                    async: true
                    expr: "(async () => { const status = await readDoctorMemoryStatus(env); const lightReport = await fs.readFile(lightReportPath, 'utf8').catch(() => ''); const remReport = await fs.readFile(remReportPath, 'utf8').catch(() => ''); const promotedMemory = await fs.readFile(memoryPath, 'utf8').catch(() => ''); if (!lightReport.includes('# Light Sleep')) return undefined; if (!remReport.includes('# REM Sleep')) return undefined; if (!promotedMemory.includes(config.expectedNeedle)) return undefined; if (status.dreaming?.phases?.deep?.managedCronPresent !== true) return undefined; if ((status.dreaming?.promotedTotal ?? 0) < 1) return undefined; return { status, lightReport, remReport, promotedMemory }; })()"
                - expr: liveTurnTimeoutMs(env, 180000)
                - 1000
          finally:
            - call: patchConfig
              args:
                - env:
                    ref: env
                  patch:
                    plugins:
                      entries:
                        memory-core:
                          config:
                            dreaming:
                              expr: "dreamingOriginal === undefined ? null : structuredClone(dreamingOriginal)"
            - call: waitForGatewayHealthy
              args:
                - ref: env
            - call: waitForQaChannelReady
              args:
                - ref: env
                - 60000
    detailsExpr: "JSON.stringify({ promotedTotal: promoted.status.dreaming?.promotedTotal ?? 0, shortTermCount: promoted.status.dreaming?.shortTermCount ?? 0, phaseSignalCount: promoted.status.dreaming?.phaseSignalCount ?? 0, lightSleep: promoted.lightReport.includes('# Light Sleep'), remSleep: promoted.remReport.includes('# REM Sleep') })"
```
