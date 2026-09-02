---
summary: "What OpenClaw sends: a daily update check by default, optional anonymous feature statistics, and every privacy control"
title: "Usage telemetry and update checks"
read_when:
  - Checking what information OpenClaw sends and what it never collects
  - Deciding whether to share anonymous feature statistics
  - Enabling or disabling anonymous feature statistics
  - Disabling all automatic update-check requests
---

**The only thing OpenClaw sends on its own is a daily update check.** It asks
whether a newer version exists, and the request carries nothing but the version,
operating system, and CPU architecture already visible to any package registry.
Everything else on this page is opt-in.

Anonymous feature statistics — which channels and providers you have configured
— are **off by default** and never turn themselves on. When you do enable them,
they ride along with that same daily update check instead of adding a second
request.

If you turn them on: thank you. Feature statistics are the only way we learn
which channels, providers, and plugins people actually use, and they decide what
gets improved, what gets fixed first, and what can safely be retired. A handful
of Discord anecdotes is otherwise the entire evidence base. We publish what we
learn back to everyone at
[telemetry.openclaw.ai](https://telemetry.openclaw.ai), so the data you
contribute stays visible to you.

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
statistics are enabled, it prints the exact JSON payload the next request would
send. When only feature statistics are disabled, it shows the update-only request
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
the existing update notice. Unreachable services, timeouts, invalid responses,
and other failed checks do not interrupt startup or normal operation.

A successful response and its timestamp are cached in the existing shared state
database. Startup reuses the cached result for the next 24 hours, and a running
Gateway checks again during normal maintenance with a small random delay. Failed
checks do not count as successful daily checks.

For testing or self-hosting, set `OPENCLAW_TELEMETRY_ENDPOINT` to your complete
replacement endpoint URL. The public server source is available at
[openclaw/telemetry](https://github.com/openclaw/telemetry).

## Optional anonymous feature statistics

Feature statistics are **off by default**. Interactive setup offers a one-time
opt-in with **No thanks** selected by default. Non-interactive and scripted
installations never opt in automatically. OpenClaw records when you accepted or
declined so it does not ask again.

When you explicitly enable feature statistics, the same daily request becomes a
`POST` with this complete JSON payload:

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

| Field                       | Meaning                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `schema`                    | Payload format version, currently `1`.                                    |
| `version`                   | Installed OpenClaw version.                                               |
| `platform`                  | Operating system and CPU architecture.                                    |
| `node`                      | Running Node.js version.                                                  |
| `surface`                   | Request origin: `gateway` or `cli`.                                       |
| `features.channels`         | Publicly known enabled channel plugin names, sorted alphabetically.       |
| `features.providerFamilies` | Publicly known configured provider names; never model names.              |
| `features.plugins`          | Publicly known enabled plugin names, sorted alphabetically.               |
| `features.pluginsEnabled`   | Total enabled plugins, including privately developed plugins never named. |
| `features.sessionsLast24h`  | Number of sessions observed during the preceding 24 hours.                |

OpenClaw names only plugins and channels that are bundled with OpenClaw or
already appear in its official plugin catalog. Privately developed plugins are
counted but never named because a private plugin name could identify its
organization. Subtract `features.plugins.length` from `features.pluginsEnabled`
to find the number of unnamed private plugins.

The sender and `openclaw telemetry show` use the same payload builder, so the
JSON displayed by the CLI is the same payload the sender would use at that
moment.

Reports carry no identifier of any kind, which means they cannot be linked to
each other. We can see that some install runs Telegram with Anthropic models; we
cannot see that it is the same install as yesterday, and we cannot build a
history of any single machine. That costs us retention analysis, and we consider
it worth paying.

### What is never collected

Neither request tier includes message content, prompts, model names, API keys,
credentials, secret references, file paths, hostnames, account identifiers,
user identifiers, or installation and machine identifiers. OpenClaw does not
create a random UUID or other persistent request identifier, so daily requests
cannot be linked through an OpenClaw-issued identifier.

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

See [Configuration reference](/gateway/configuration-reference#telemetry) for
the full `telemetry` configuration and
[Update configuration](/gateway/configuration-reference#update) for the
automatic update-check controls.
