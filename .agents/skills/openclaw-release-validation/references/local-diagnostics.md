# Optional local diagnostics

Offer this step only after an isolated OCM target is ready. For either in-place
lane, mark diagnostics skipped and say no telemetry plugin will be installed on
the tester's real gateway. For an isolated target, say:

```text
Optional local diagnostics can capture traces, metrics, and logs from this
test gateway. It installs OpenClaw's diagnostics-otel plugin only in the
disposable copy and sends OTLP only to a collector on this machine. Content
capture stays off. Nothing is sent to a hosted endpoint, and you will review
the exact release-report draft before any GitHub comment is posted.

Reply exactly `enable local diagnostics` to enable it, or `skip local diagnostics` to continue without it.
```

Do nothing until the tester chooses. If they skip it, record no diagnostic
state and continue to the worksheet. If Docker is unavailable or its daemon is
not running, state that local diagnostics are unavailable and continue without
it. Do not install Docker, use a hosted collector, or fall back to a remote
endpoint.

When the tester replies `enable local diagnostics`:

1. Create a `telemetry/` directory beside the private local worksheet artifact
   directory. It is private run data, not worksheet content and never GitHub
   content. Create this collector configuration as `otel-collector.yaml` in
   that directory:

   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 0.0.0.0:4318
   processors:
     batch:
       timeout: 1s
       send_batch_size: 256
   exporters:
     file/traces:
       path: /telemetry/traces.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/metrics:
       path: /telemetry/metrics.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
     file/logs:
       path: /telemetry/logs.jsonl
       rotation:
         max_megabytes: 8
         max_backups: 1
   service:
     telemetry:
       logs:
         level: warn
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/traces]
       metrics:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/metrics]
       logs:
         receivers: [otlp]
         processors: [batch]
         exporters: [file/logs]
   ```

2. Start one run-owned collector with the maintained, pinned
   `otel/opentelemetry-collector-contrib:0.104.0` image. Mount the configuration
   read-only and the private telemetry directory read-write. Use
   `-p 127.0.0.1::4318` so Docker chooses an unused host port and publishes it
   only on loopback. Use `--read-only`, `--cap-drop=ALL`,
   `--security-opt no-new-privileges`, `--pids-limit 128`, and a small `/tmp`
   tmpfs. Inspect the running container and resolve its assigned host port with
   `docker port <collector-name> 4318/tcp`. Require a `127.0.0.1:<port>`
   binding; stop the collector and skip capture if anything else is exposed.
   The collector configuration has file exporters only: never add an exporter,
   endpoint, header, or credential supplied by the source gateway.
3. Install the current official ClawHub package into the fixture only:
   `ocm @<test-env> -- plugins install clawhub:@openclaw/diagnostics-otel`.
   The test target verifies the plugin API compatibility during installation.
   Require a successful `plugins inspect diagnostics-otel --json` that reports
   the official ClawHub source and an accepted compatible version. If that
   compatibility check fails, stop the collector, report capture unavailable,
   and continue without diagnostics. Do not force the install, use a local code
   checkout, or select an unverified package version. Enable it with
   `ocm @<test-env> -- plugins enable diagnostics-otel`.
4. Replace only the fixture's `diagnostics.otel` object with this exact JSON
   value using
   `ocm @<test-env> -- config set diagnostics.otel <json> --strict-json`. Do not
   merge, so old signal-specific or remote endpoints cannot survive:

   ```json
   {
     "enabled": true,
     "endpoint": "http://127.0.0.1:<assigned-port>",
     "protocol": "http/protobuf",
     "serviceName": "openclaw-release-validation",
     "traces": true,
     "metrics": true,
     "logs": true,
     "logsExporter": "otlp",
     "sampleRate": 1,
     "flushIntervalMs": 1000,
     "captureContent": false
   }
   ```

   Also set `diagnostics.enabled` to `true`, validate the fixture config, then
   restart it through `ocm service restart <test-env>`. Verify the plugin is
   enabled, the collector remains loopback-only, and the fixture is healthy.
   On any failure, disable the plugin, set `diagnostics.otel.enabled` to
   `false`, stop the collector, and continue the release test without local
   diagnostics. Keep these setup failures out of the worksheet and GitHub.

Keep the collector running only while the fixture is under test. It captures
traces, metrics, and logs locally with bounded file rotation. The source
gateway, personal OpenClaw home, and shared GitHub issue remain untouched.
