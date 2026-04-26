# Long-running release audit

```yaml qa-scenario
id: long-running-release-audit
title: Long-running release audit
surface: workspace
coverage:
  primary:
    - workspace.long-running-task
  secondary:
    - workspace.repo-discovery
    - workspace.artifacts
objective: Verify a model can complete a sustained repo audit that requires reading several scattered files, ignoring stale decoys, writing artifacts, and checking its own output.
successCriteria:
  - Agent starts from the seeded project README instead of guessing.
  - Agent inspects docs and source files across multiple directories.
  - Agent writes a JSON audit and a Markdown handoff with all required findings.
  - Agent verifies the generated JSON before finalizing.
docsRefs:
  - docs/help/testing.md
  - qa/scenarios/index.md
codeRefs:
  - extensions/qa-lab/src/suite.ts
  - extensions/qa-lab/src/scenario-flow-runner.ts
execution:
  kind: flow
  summary: Verify sustained repo-style auditing with scattered evidence and artifact verification.
  config:
    reportFile: audit-fixture/release-audit.json
    handoffFile: audit-fixture/release-handoff.md
    expectedFindings:
      - REL-GATEWAY-417
      - REL-CHANNEL-238
      - REL-CRON-904
      - REL-MEMORY-552
      - REL-PLUGIN-319
      - REL-INSTALL-846
      - REL-DOCS-611
    workspaceFiles:
      audit-fixture/README.md: |-
        # Finch Relay

        Release readiness task:

        The release checklist was renamed during docs cleanup.
        Find the current checklist under `docs/`, then inspect the referenced
        source and notes. Produce:

        - `release-audit.json`
        - `release-handoff.md`

        Do not use `docs/archive/old-release-notes.md` as current evidence.
        Historical path that may appear in stale notes: `docs/release-checklist.md`.
      audit-fixture/docs/current-readiness-checklist.md: |-
        # Release Checklist

        Current release readiness requires checking eight areas:

        1. gateway reconnect handling
        2. channel delivery ordering
        3. cron duplicate prevention
        4. memory recall fallback
        5. plugin runtime loading
        6. control UI status copy
        7. installer update path
        8. docs update status

        Useful current sources:

        - `src/gateway/reconnect.ts`
        - `src/channels/delivery.ts`
        - `src/scheduling/cron.ts`
        - `src/memory/recall.ts`
        - `src/plugins/runtime.ts`
        - `ui/control-panel.ts`
        - `install/update.ts`
        - `docs/operator-notes.md`

        The archive folder contains stale notes and should not be treated as
        current release evidence.
      audit-fixture/docs/operator-notes.md: |-
        # Operator Notes

        Current docs update status:

        Finding id: REL-DOCS-611
        Status: docs mention reconnect, cron, memory, plugin, and installer checks,
        but the channel ordering and UI notes still need maintainer handoff.
      audit-fixture/docs/archive/old-release-notes.md: |-
        # Old Release Notes

        Stale finding id: REL-STALE-000
        This file is from a previous release and should not appear in the new
        release audit.
      audit-fixture/src/gateway/reconnect.ts: |-
        export const gatewayReconnectReleaseFinding = {
          id: "REL-GATEWAY-417",
          area: "gateway reconnect handling",
          status: "retry jitter verified, resume token fallback still needs manual spot check",
        };
      audit-fixture/src/channels/delivery.ts: |-
        export const channelDeliveryReleaseFinding = {
          id: "REL-CHANNEL-238",
          area: "channel delivery ordering",
          status: "thread replies preserve ordering, root-channel fallback needs handoff note",
        };
      audit-fixture/src/scheduling/cron.ts: |-
        export const cronDuplicateReleaseFinding = {
          id: "REL-CRON-904",
          area: "cron duplicate prevention",
          status: "single-run lock verified for restart wakeups",
        };
      audit-fixture/src/memory/recall.ts: |-
        export const memoryRecallReleaseFinding = {
          id: "REL-MEMORY-552",
          area: "memory recall fallback",
          status: "fallback summary survives empty memory search, but ranking sample needs second reviewer",
        };
      audit-fixture/src/plugins/runtime.ts: |-
        export const pluginRuntimeReleaseFinding = {
          id: "REL-PLUGIN-319",
          area: "plugin runtime loading",
          status: "bundled runtime manifest loads cleanly after restart",
        };
      audit-fixture/install/update.ts: |-
        export const installerUpdateReleaseFinding = {
          id: "REL-INSTALL-846",
          area: "installer update path",
          status: "update smoke passed from previous stable tag",
        };
    prompt: |-
      Do a release readiness audit for the small project under `audit-fixture/`.
      Start from `audit-fixture/README.md`, find the current checklist, inspect the referenced docs/source, then create `audit-fixture/release-audit.json` and `audit-fixture/release-handoff.md`.

      The JSON should include current finding ids, source files, statuses, and a boolean `verified`.
      The Markdown handoff should summarize what is ready and what needs follow-up.
      Check your generated JSON before finalizing.
      Final reply exactly: RELEASE-AUDIT-COMPLETE
```

```yaml qa-flow
steps:
  - name: completes the sustained release audit with verified artifacts
    actions:
      - call: waitForGatewayHealthy
        args:
          - ref: env
          - 60000
      - call: reset
      - forEach:
          items:
            expr: "Object.entries(config.workspaceFiles ?? {})"
          item: workspaceFile
          actions:
            - set: seededPath
              value:
                expr: "path.join(env.gateway.workspaceDir, String(workspaceFile[0]))"
            - call: fs.mkdir
              args:
                - expr: "path.dirname(seededPath)"
                - recursive: true
            - call: fs.writeFile
              args:
                - ref: seededPath
                - expr: "`${String(workspaceFile[1] ?? '').trimEnd()}\\n`"
                - utf8
      - set: sessionKey
        value:
          expr: "`agent:qa:release-audit:${randomUUID().slice(0, 8)}`"
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey:
              ref: sessionKey
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 120000)
      - set: reportPath
        value:
          expr: "path.join(env.gateway.workspaceDir, config.reportFile)"
      - set: handoffPath
        value:
          expr: "path.join(env.gateway.workspaceDir, config.handoffFile)"
      - call: waitForCondition
        saveAs: reportText
        args:
          - lambda:
              async: true
              expr: "fs.readFile(reportPath, 'utf8').then((value) => config.expectedFindings.every((finding) => value.includes(finding)) ? value : undefined).catch(() => undefined)"
          - expr: liveTurnTimeoutMs(env, 60000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - call: waitForCondition
        saveAs: handoffText
        args:
          - lambda:
              async: true
              expr: "fs.readFile(handoffPath, 'utf8').then((value) => config.expectedFindings.every((finding) => value.includes(finding)) && !value.includes('REL-STALE-000') ? value : undefined).catch(() => undefined)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - set: report
        value:
          expr: "JSON.parse(reportText)"
      - assert:
          expr: "['src/gateway/reconnect.ts', 'src/channels/delivery.ts', 'src/scheduling/cron.ts', 'src/memory/recall.ts', 'src/plugins/runtime.ts', 'install/update.ts', 'docs/operator-notes.md'].every((file) => JSON.stringify(report).includes(file))"
          message:
            expr: "`report missing expected source refs: ${reportText}`"
      - assert:
          expr: "config.expectedFindings.every((finding) => JSON.stringify(report).includes(finding))"
          message:
            expr: "`report missing expected finding ids: ${reportText}`"
      - assert:
          expr: "!JSON.stringify(Array.isArray(report.findings) ? report.findings : report).includes('REL-STALE-000') && !handoffText.includes('REL-STALE-000')"
          message:
            expr: "`stale archive finding leaked into audit: report=${reportText}\\nhandoff=${handoffText}`"
      - assert:
          expr: "JSON.stringify(report).includes('ui/control-panel.ts') && /blocked|missing|not found/i.test(`${reportText}\\n${handoffText}`)"
          message:
            expr: "`missing UI evidence was not explicitly blocked: report=${reportText}\\nhandoff=${handoffText}`"
      - assert:
          expr: "JSON.stringify(report).includes('verified')"
          message:
            expr: "`report did not include a verification field: ${reportText}`"
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && candidate.text.trim() === 'RELEASE-AUDIT-COMPLETE').at(-1)"
          - expr: liveTurnTimeoutMs(env, 45000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - call: readRawQaSessionStore
        saveAs: store
        args:
          - ref: env
      - set: sessionEntry
        value:
          expr: "store[sessionKey]"
      - assert:
          expr: "Boolean(sessionEntry)"
          message:
            expr: "`missing QA session entry for ${sessionKey}`"
    detailsExpr: "`${outbound.text}\\n${reportText}\\n\\n${handoffText}`"
```
