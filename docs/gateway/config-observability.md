---
summary: "Observability config: audit, logging, diagnostics, and telemetry keys"
read_when:
  - Turning on audit or diagnostics capture
  - Tuning log level, rotation, or redaction
  - Configuring telemetry export
title: "Configuration — audit, logging, diagnostics, and telemetry"
---

Observability keys: `audit.*`, `logging.*`, `diagnostics.*`, and `telemetry.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## Audit

```json5
{
  logging: {
    audit: {
      enabled: true,
      executionIdentity: false,
      messages: "off", // off | direct | all
    },
  },
}
```

The Gateway records **metadata-only** audit events for agent runs and tool
actions into the shared state database. Message lifecycle metadata is a
separate opt-in. The ledger stores identity, timing, tool names, and normalized
outcomes, but never prompts, message bodies, tool arguments, results, or raw
error text. Message rows do not store raw platform account, conversation,
message, and target ids. Run/tool session keys remain available for correlation
and can themselves contain platform account or peer ids. Records
expire after 30 days and the ledger is capped at 100,000 rows. Query them with
[`openclaw audit`](/cli/audit) or the
[`audit.activity.list`](/gateway/protocol/ledgers#audit-ledger-rpc) Gateway RPC. See
[Audit history](/gateway/audit) for the full data model, privacy semantics,
and coverage limits.

- `enabled`: record new audit events (default: `true`). The ledger is on by
  default because an audit trail enabled only after an incident cannot explain
  the incident. Setting `false` stops new event inserts after the Gateway restarts;
  existing records stay readable until they expire. Turning it back on resumes
  recording from that point — the gap is not backfilled.
- `executionIdentity`: retain bounded attribution context for exact execution
  inspection (default: `false`). This privacy-sensitive metadata is disabled
  on fresh installs and upgrades. Collection requires `enabled: true`; use
  `openclaw config set logging.audit.executionIdentity true`, then restart the
  Gateway. There is no environment-variable alias.
- `messages`: message metadata scope (default: `"off"`). `"direct"` records
  known direct conversations only. `"all"` also records group, channel, and
  unknown conversation kinds. Both modes remain content-free and replace raw
  identifiers with installation-local keyed pseudonyms where correlation is
  available. These are correlation aids rather than anonymization; the state
  database stores the derivation key, but RPC and CLI exports do not.

A root-level `audit` block is retired; the canonical path is `logging.audit`.
The root config object is strict, so an old top-level `audit` block is rejected.
Run [`openclaw doctor --fix`](/cli/doctor) to move it to `logging.audit`.

The running Gateway captures `logging.audit.enabled`,
`logging.audit.executionIdentity`, and `logging.audit.messages` at startup;
restart it after changing any of these settings. Message coverage currently includes
accepted inbound messages that reach core dispatch and one terminal row per
original logical outbound reply payload that reaches shared durable delivery.
Plugin-local and direct-send paths that bypass those shared boundaries are not
yet covered. The bounded background
writer is best-effort, not a lossless compliance archive.

---

## Logging

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty", // pretty | json
    redactPatterns: ["\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1"],
  },
}
```

- Default log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`; named profiles use `/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`.
- Set `logging.file` for a stable path.
- `consoleLevel` bumps to `debug` when `--verbose`.
- `consoleStyle`: `"pretty"` or `"json"`. The earlier `"compact"` value is retired; [`openclaw doctor --fix`](/cli/doctor) maps it to `"pretty"`.
- `maxFileBytes`: maximum active log file size in bytes before rotation (positive integer; default: `104857600` = 100 MB). OpenClaw keeps up to five numbered archives beside the active file.
- `redactPatterns`: regexes for best-effort masking of console output, file logs, OTLP log records, and persisted session transcript text. Setting this **replaces** the built-in default patterns for log and transcript output, so include the defaults you still want; omitting them also turns off form-body and structured auth-header redaction. Tool payload redaction is separate and always merges your patterns with the defaults.
- Redaction is always on and is no longer configurable. [`openclaw doctor --fix`](/cli/doctor) removes the retired switch from older config files; the runtime always applies `tools`-mode redaction to logs and transcripts. UI, tool, and diagnostic safety surfaces redact secrets independently of this policy.

---

## Diagnostics

```json5
{
  diagnostics: {
    enabled: true,
    flags: ["telegram.*"],

    otel: {
      enabled: false,
      endpoint: "https://otel-collector.example.com:4318",
      tracesEndpoint: "https://traces.example.com/v1/traces",
      metricsEndpoint: "https://metrics.example.com/v1/metrics",
      logsEndpoint: "https://logs.example.com/v1/logs",
      protocol: "http/protobuf",
      headers: { "x-tenant-id": "my-org" },
      serviceName: "openclaw-gateway",
      traces: true,
      metrics: true,
      logs: false,
      logsExporter: "otlp",
      sampleRate: 1.0,
      flushIntervalMs: 5000,
      captureContent: false,
    },

    cacheTrace: {
      enabled: false,
    },
  },
}
```

- `enabled`: master toggle for instrumentation output (default: `true`).
- `flags`: array of flag strings enabling targeted log output (supports wildcards like `"telegram.*"` or `"*"`).
- `otel.enabled`: enables the OpenTelemetry export pipeline (default: `false`). For the full configuration, signal catalog, and privacy model, see [OpenTelemetry export](/gateway/opentelemetry).
- `otel.endpoint`: collector URL for OTel export.
- `otel.tracesEndpoint` / `otel.metricsEndpoint` / `otel.logsEndpoint`: optional signal-specific OTLP endpoints. When set, they override `otel.endpoint` for that signal only.
- `otel.protocol`: `"http/protobuf"` (default). gRPC export is retired; run [`openclaw doctor --fix`](/cli/doctor) to repair a persisted legacy value or get source-specific manual-edit guidance.
- `otel.headers`: extra HTTP request headers sent with OTel export requests.
- `otel.serviceName`: service name for resource attributes.
- `otel.traces` / `otel.metrics` / `otel.logs`: enable trace, metrics, or log export.
- `otel.logsExporter`: log export sink: `"otlp"` (default), `"stdout"` for one JSON object per stdout line, or `"both"`.
- `otel.sampleRate`: trace sampling rate `0`-`1`.
- `otel.flushIntervalMs`: periodic telemetry flush interval in ms.
- `otel.captureContent`: opt-in content capture for OTEL span attributes. Defaults to off. `true` captures non-system visible message, tool, and tool-definition content plus OTLP log bodies; provider-internal thinking payloads remain excluded.
- `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`: environment toggle for latest experimental GenAI inference span shape, including `{gen_ai.operation.name} {gen_ai.request.model}` span names, `CLIENT` span kind, and `gen_ai.provider.name` instead of legacy `gen_ai.system`. By default spans keep `openclaw.model.call` and `gen_ai.system` for compatibility; GenAI metrics use bounded semantic attributes.
- `OPENCLAW_OTEL_PRELOADED=1`: environment toggle for hosts that already registered a global OpenTelemetry SDK. OpenClaw then skips plugin-owned SDK startup/shutdown while keeping diagnostic listeners active.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: signal-specific endpoint env vars used when the matching config key is unset.
- `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, and `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`: signal-specific protocol fallbacks used when `otel.protocol` is unset. Each overrides `OTEL_EXPORTER_OTLP_PROTOCOL` for its signal.
- `OTEL_EXPORTER_OTLP_PROTOCOL`: shared protocol fallback used when neither `otel.protocol` nor the matching signal-specific variable is set. Only `http/protobuf` is supported. Protocol validation is isolated per signal, so an unsupported resolved value disables that signal's OTLP exporter without blocking supported sibling signals. Doctor does not rewrite environment variables.
- `cacheTrace.enabled`: log cache trace snapshots for embedded runs (default: `false`).

---

## Telemetry

```json5
{
  telemetry: {
    enabled: false,
    consentedAt: "2026-08-02T12:00:00.000Z",
  },
}
```

- `enabled`: include public configured channel and provider names, plugin inventory names and count, and a retained session-creation count in the existing daily update-check request (default: `false`). These fields do not measure per-plugin usage or active sessions. Interactive setup can offer an explicit opt-in with **No thanks** selected by default; non-interactive setup does not enable it automatically but can retain an explicitly enabled preference. `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true` always disables feature statistics without disabling the update check.
- `consentedAt`: ISO timestamp recording when the operator accepted or declined feature statistics. Prevents interactive setup from asking again.
- `openclaw telemetry show` previews the request using the CLI process's current context, which can differ from the running Gateway; `openclaw telemetry on` and `openclaw telemetry off` update the preference and consent timestamp.
- `OPENCLAW_TELEMETRY_ENDPOINT`: optional full endpoint URL for testing or a self-hosted service. Defaults to `https://telemetry.openclaw.ai/api/latest-version`.

See [Usage telemetry and update checks](/gateway/telemetry) for the complete payload, privacy guarantees, and all opt-out controls.

---
