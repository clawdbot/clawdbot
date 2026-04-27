# Docker Prometheus smoke

```yaml qa-scenario
id: docker-prometheus-smoke
title: Docker Prometheus smoke
surface: telemetry
coverage:
  primary:
    - telemetry.prometheus
  secondary:
    - harness.qa-lab
    - docker.e2e
objective: Verify a QA-lab gateway run emits protected, bounded Prometheus diagnostics metrics through the diagnostics-prometheus plugin.
successCriteria:
  - The diagnostics-prometheus plugin exposes the protected scrape route.
  - An unauthenticated scrape is rejected.
  - A minimal QA-channel agent turn completes.
  - The authenticated scrape includes release-critical diagnostics metric families.
  - Prometheus output omits prompt content, session keys, auth tokens, raw ids, and file paths.
plugins:
  - diagnostics-prometheus
gatewayConfigPatch:
  diagnostics:
    enabled: true
docsRefs:
  - docs/gateway/prometheus.md
  - docs/concepts/qa-e2e-automation.md
codeRefs:
  - extensions/diagnostics-prometheus/src/service.ts
  - src/diagnostics/internal-diagnostics.ts
  - extensions/qa-lab/src/suite.ts
execution:
  kind: flow
  summary: Complete a minimal QA-lab turn and scrape the protected Prometheus route.
  config:
    prompt: Reply exactly DOCKER-PROMETHEUS-OK. Do not repeat DOCKER-PROMETHEUS-SECRET.
    secretNeedle: DOCKER-PROMETHEUS-SECRET
```

```yaml qa-flow
steps:
  - name: emits protected low-cardinality prometheus metrics
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
      - set: startCursor
        value:
          expr: state.getSnapshot().messages.length
      - call: runAgentPrompt
        args:
          - ref: env
          - sessionKey: agent:qa:docker-prometheus-smoke
            message:
              expr: config.prompt
            timeoutMs:
              expr: liveTurnTimeoutMs(env, 30000)
      - call: waitForCondition
        saveAs: outbound
        args:
          - lambda:
              expr: "state.getSnapshot().messages.slice(startCursor).filter((candidate) => candidate.direction === 'outbound' && candidate.conversation.id === 'qa-operator' && String(candidate.text ?? '').trim().length > 0).at(-1)"
          - expr: liveTurnTimeoutMs(env, 30000)
          - expr: "env.providerMode === 'mock-openai' ? 100 : 250"
      - assert:
          expr: "String(outbound.text ?? '').trim().length > 0"
          message: "expected non-empty qa output before scraping metrics"
      - set: prometheusUrl
        value:
          expr: "`${env.gateway.baseUrl}/api/diagnostics/prometheus`"
      - set: gatewayToken
        value:
          expr: "String(env.gateway.token ?? env.gateway.runtimeEnv.OPENCLAW_GATEWAY_TOKEN ?? '')"
      - assert:
          expr: "gatewayToken.length > 0"
          message: "expected QA gateway token to be available for protected scrape"
      - set: unauthenticatedScrape
        value:
          expr: |-
            (async () => {
              const response = await fetch(prometheusUrl);
              await response.text().catch(() => "");
              return { status: response.status };
            })()
      - assert:
          expr: "unauthenticatedScrape.status === 401 || unauthenticatedScrape.status === 403"
          message:
            expr: "`expected unauthenticated prometheus scrape to be rejected, got ${unauthenticatedScrape.status}`"
      - set: authenticatedScrape
        value:
          expr: |-
            (async () => {
              const response = await fetch(prometheusUrl, {
                headers: { authorization: `Bearer ${gatewayToken}` },
              });
              const text = await response.text();
              return {
                status: response.status,
                contentType: response.headers.get("content-type") ?? "",
                text,
              };
            })()
      - assert:
          expr: "authenticatedScrape.status === 200"
          message:
            expr: "`expected authenticated prometheus scrape to return 200, got ${authenticatedScrape.status}`"
      - assert:
          expr: "authenticatedScrape.contentType.includes('text/plain')"
          message:
            expr: "`expected prometheus text content type, got ${authenticatedScrape.contentType}`"
      - set: prometheusText
        value:
          expr: "String(authenticatedScrape.text ?? '')"
      - assert:
          expr: "prometheusText.includes('# TYPE openclaw_run_completed_total counter')"
          message: "missing run completion counter"
      - assert:
          expr: "prometheusText.includes('# TYPE openclaw_run_duration_seconds histogram')"
          message: "missing run duration histogram"
      - assert:
          expr: "prometheusText.includes('# TYPE openclaw_model_call_total counter')"
          message: "missing model call counter"
      - assert:
          expr: "prometheusText.includes('# TYPE openclaw_harness_run_total counter')"
          message: "missing harness run counter"
      - assert:
          expr: "!prometheusText.includes(config.secretNeedle)"
          message: "prometheus output leaked prompt sentinel"
      - assert:
          expr: "!prometheusText.includes('DOCKER-PROMETHEUS-OK')"
          message: "prometheus output leaked response content"
      - assert:
          expr: "!prometheusText.includes('agent:qa:docker-prometheus-smoke')"
          message: "prometheus output leaked the session key"
      - assert:
          expr: "!prometheusText.includes(gatewayToken)"
          message: "prometheus output leaked the gateway token"
      - assert:
          expr: "!/runId|sessionId|sessionKey|callId|toolCallId|messageId|providerRequestId/.test(prometheusText)"
          message: "prometheus output leaked raw diagnostic identifiers"
      - assert:
          expr: "!/\\/tmp\\/|\\/private\\/tmp\\/|\\/app\\//.test(prometheusText)"
          message: "prometheus output leaked a local file path"
      - assert:
          expr: "!prometheusText.includes('openclaw.content.')"
          message: "prometheus output leaked content attributes"
      - assert:
          expr: "!/openclaw_prometheus_series_dropped_total(?:\\{[^}]*\\})?\\s+(?!0(?:\\.0+)?(?:\\s|$))/.test(prometheusText)"
          message: "prometheus dropped series during the smoke"
```
