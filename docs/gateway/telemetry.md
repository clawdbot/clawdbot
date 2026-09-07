---
summary: "What OpenClaw sends: a daily update check by default, optional anonymous feature statistics, and every privacy control"
title: "Usage telemetry and update checks"
read_when:
  - Checking what information OpenClaw sends and what it never collects
  - Deciding whether to share anonymous feature statistics
  - Enabling or disabling anonymous feature statistics
  - Disabling all automatic update-check requests
---

**Automatic update checks send a daily request by default.** It asks whether a
newer version exists and includes the OpenClaw version, operating system, Node.js
version, CPU architecture, and request surface. Feature statistics are opt-in.
This page describes update-check telemetry, not requests made by configured
providers, channels, or other services.

Anonymous feature statistics describe configured channels and providers, plugin
inventory, and a retained session-creation count. They are **off by default**.
When you enable them, they ride along with that same daily update check instead
of adding a second request.

These reports help inform maintenance priorities. They do not measure individual
plugin invocations, messages, model requests, or active users. Public aggregates
are available at
[telemetry.openclaw.ai](https://telemetry.openclaw.ai).

Declining is a completely normal choice and changes nothing about how OpenClaw
works for you.

## Inspect what is sent

Run this command before or after changing your preference:

```bash
openclaw telemetry show
```

Add `--json` to get the same state and payload as one machine-readable
document.

The output shows whether feature statistics are enabled, why they are enabled
or disabled, the request endpoint, and the last successful check. When feature
statistics are enabled, it prints a JSON payload preview built in the CLI
process. It does not retrieve a payload from the running Gateway. When only
feature statistics are disabled, it shows the update-only request
and its `User-Agent` header instead. When automation or update-check policy
disables all requests, it shows `Request: none` with the reason (`request: null`
in JSON).

## Daily update check

The default request is:

```http
GET https://telemetry.openclaw.ai/api/latest-version
User-Agent: openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)
```

The `User-Agent` contains the OpenClaw version, operating system, Node.js
version, CPU architecture, and whether the request came from the Gateway or
CLI. It has no request body, install identifier, machine identifier, or random
tracking identifier.

The service responds with the latest version and, optionally, a short
operator-facing note. OpenClaw displays an available update and its note through
the existing update notice. Unreachable services, timeouts, oversized or invalid responses,
and other failed checks do not interrupt startup or normal operation.

A successful response and its timestamp are cached in the existing shared state
database. Startup reuses the cached result for the next 24 hours, and a running
Gateway checks again during normal maintenance with a small random delay. Failed
checks do not count as successful daily checks.

For testing or self-hosting, set `OPENCLAW_TELEMETRY_ENDPOINT` to your complete
replacement endpoint URL. The public server source is available at
[openclaw/telemetry](https://github.com/openclaw/telemetry).

## Optional anonymous feature statistics

Feature statistics are **off by default**. Interactive setup can offer a one-time
opt-in with **No thanks** selected by default; guided Quick Start skips that
prompt. OpenClaw records a prompt response so setup does not ask again.
Non-interactive and scripted installations do not opt in automatically, but
operators can explicitly enable statistics with `openclaw telemetry on` or
`telemetry.enabled: true`. The enabled setting, not the presence of a prompt
response, controls whether feature statistics are included.

When you explicitly enable feature statistics, the same daily request becomes a
`POST` with a JSON payload in this shape (values are illustrative):

```json
{
  "schema": 1,
  "version": "2026.8.2",
  "platform": "darwin-arm64",
  "node": "26.0.1",
  "surface": "gateway",
  "features": {
    "channels": ["discord", "telegram"],
    "providerFamilies": ["anthropic", "openai"],
    "plugins": ["codex", "diagnostics-otel"],
    "pluginsEnabled": 9,
    "sessionsLast24h": 14
  }
}
```

| Field                       | Meaning                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `schema`                    | Payload format version, currently `1`.                                                            |
| `version`                   | Installed OpenClaw version.                                                                       |
| `platform`                  | Operating system and CPU architecture.                                                            |
| `node`                      | Running Node.js version.                                                                          |
| `surface`                   | Request surface: `gateway` or `cli`; the CLI preview uses `gateway`.                              |
| `features.channels`         | Configured, not explicitly disabled channel IDs backed by public plugins in the inventory.        |
| `features.providerFamilies` | Public provider IDs from configuration, auth profiles, and configured model references.           |
| `features.plugins`          | Public plugin IDs from the enabled inventory, sorted alphabetically.                              |
| `features.pluginsEnabled`   | Total plugins in that inventory, including plugins not named in `features.plugins`.               |
| `features.sessionsLast24h`  | Retained session-creation events timestamped within the preceding 24 hours, not session activity. |

With an active plugin registry, the inventory includes enabled, loaded plugins
whose code was imported, plus loaded bundle-format plugins. Without that
registry, it falls back to configured manifest enablement. Neither path records
whether a plugin was invoked or a configured channel or provider handled work.

Named plugins must be bundled, trusted official installs, or match the official
plugin catalog. Private plugin identities are not named. Names are also filtered
and deduplicated, and the service validates them independently. The difference
between `features.pluginsEnabled` and the number of reported names is therefore
not a reliable count of private plugins.

The session count depends on locally recorded creation events that remain in
the bounded event store. Missing or unreadable state produces zero. It is not
a count of active sessions, messages, or all sessions that existed that day.

The sender and `openclaw telemetry show` use the same payload builder, but their
plugin registry, configuration, and collection time can differ. The CLI preview
is not a guarantee of the exact next Gateway payload.

Reports have no persistent client identifier. Repeated reports are not unique
installations or users, and the reported fields do not provide a per-install
history or retention measure.

### What is never collected

Neither the update-check `User-Agent` nor the feature-statistics body includes
message content, prompts, model names, API keys, credentials, secret references,
file paths, hostnames, account identifiers, user identifiers, or installation
and machine identifiers. OpenClaw does not create a random UUID or other
persistent client identifier for these requests.

The service's Analytics Engine rows exclude those identifying fields and client
IP addresses. Cloudflare still handles TLS and network requests and sees the
client IP. The Worker reads that IP transiently for rate limiting without writing
it to Analytics Engine. The service's deployment configuration disables Worker
observability, logs, and invocation logs; those settings do not describe or
control Cloudflare's separate infrastructure-level processing.

Anonymous feature statistics are separate from optional, operator-configured
[OpenTelemetry export](/gateway/opentelemetry).

## Turn feature statistics on or off

Enable or disable anonymous feature statistics at any time:

```bash
openclaw telemetry on
openclaw telemetry off
```

You can also configure the same preference directly:

```json5
{
  telemetry: {
    enabled: false,
  },
}
```

Set `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true` to force feature statistics off,
even when `telemetry.enabled` is `true`. `DO_NOT_TRACK` does not disable the
daily update check: OpenClaw sends the update-only `GET` request without a
feature-statistics body.

## Automated environments

OpenClaw sends nothing when it detects an automated environment, meaning the
`CI` environment variable is set to a truthy value. Continuous integration jobs
are not installations: they would outnumber real operators by orders of
magnitude and make version and platform counts meaningless, and your pipeline
should not report to us on every job.

This applies to both tiers, so a CI job sends no update check and no feature
statistics. Setting `OPENCLAW_TELEMETRY_ENDPOINT` overrides the suppression,
because a configured endpoint means the run is deliberately exercising this
path.

## Disable every automatic update request

To go fully dark, disable the existing startup update check:

```json5
{
  update: {
    checkOnStart: false,
  },
}
```

This stops both tiers and every automatic update request: no update request, no
feature statistics, and no update notice, even when `update.auto.enabled` is
`true`. Setting `OPENCLAW_NO_AUTO_UPDATE=1` also prevents automatic update
requests and applies. Explicit update commands remain available when you choose
to run them.

See [Configuration reference](/gateway/config-observability#telemetry) for
the full `telemetry` configuration and
[Update configuration](/gateway/config-runtime#update) for the
automatic update-check controls.
