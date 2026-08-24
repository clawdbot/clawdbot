---
summary: "Understand daily update checks, optional anonymous feature statistics, and every privacy control"
title: "Usage telemetry and update checks"
read_when:
  - Checking what information OpenClaw sends during its daily update check
  - Enabling or disabling anonymous feature statistics
  - Disabling all automatic update-check requests
---

OpenClaw checks for a newer version at most once every 24 hours. By default,
this request includes only basic software and platform information. Anonymous
feature statistics are sent only when you explicitly opt in, and they reuse the
same request rather than creating a second one.

## Inspect what is sent

Run this command before or after changing your preference:

```bash
openclaw telemetry show
```

The output shows whether feature statistics are enabled, why they are enabled
or disabled, the request endpoint, and the last successful check. When feature
statistics are enabled, it prints the exact JSON payload the next request would
send. When they are disabled, it shows the update-only request and its
`User-Agent` header instead.

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
    "pluginsEnabled": 7,
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
| `features.channels`         | Enabled channel plugin names, sorted alphabetically.                      |
| `features.providerFamilies` | Configured provider names, sorted alphabetically; never model names.      |
| `features.pluginsEnabled`   | Number of enabled plugins, without plugin names or configuration details. |
| `features.sessionsLast24h`  | Number of sessions observed during the preceding 24 hours.                |

The sender and `openclaw telemetry show` use the same payload builder, so the
JSON displayed by the CLI is the same payload the sender would use at that
moment.

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
