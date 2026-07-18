---
summary: "Enable and invoke privacy-gated HealthKit summaries from an iOS node"
read_when:
  - Enabling HealthKit summaries on an iOS node
  - Invoking health.summary or troubleshooting missing health metrics
  - Reviewing what health data can leave an iOS device
title: "HealthKit summaries"
---

# HealthKit summaries

OpenClaw can request a read-only summary of the current calendar day from a
connected iPhone or iPad node. The device computes the aggregate on-device and returns
only steps, sleep duration, average resting heart rate, and workout
count/duration. Individual HealthKit samples, sources, metadata, clinical
records, background ingestion, and writes are not supported.

This feature is off by default. It requires separate consent on the iOS device and
authorization on the Gateway.

## Requirements

- An iPhone or iPad running the OpenClaw iOS app where HealthKit reports health data as
  available.
- A connected and approved iOS node. See [iOS app setup](/platforms/ios).
- A current Gateway that can reach the iOS node.
- Readable Health data for any metrics you expect to see. An Apple Watch can
  contribute data to the Apple Health store, but the OpenClaw watchOS app is
  not required for HealthKit summaries.

## Enable access

### 1. Authorize the Gateway command

Add `health.summary` to the existing `gateway.nodes.allowCommands` array in
`openclaw.json`. Preserve any commands already present:

```json5
{
  gateway: {
    nodes: {
      allowCommands: ["health.summary"],
    },
  },
}
```

`health.summary` is classified as privacy-heavy and is never allowed by the
iOS platform default. An entry in `gateway.nodes.denyCommands` overrides the
allow entry. See [Node command policy](/nodes#command-policy).

### 2. Enable sharing on the iOS device

In the iOS app:

1. Open **Settings -> Permissions** and find **Apple Health Summaries** in the
   always-visible **Apple Health** section.
2. Tap **Enable Apple Health Summaries**.
3. Read the disclosure, then choose which Health categories OpenClaw may read
   in Apple's permission sheet.

The switch records your explicit OpenClaw sharing choice. It does not claim
that Apple granted every requested category.

Enabling Health summaries adds `health.summary` to the node's declared command
surface. Approve the resulting node pairing update:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Then verify that the connected iOS device exposes an effective `health.summary`
command:

```bash
openclaw nodes describe --node "<iOS device name>"
```

## Request today's summary

Only `today` is supported. It covers local midnight through the request time,
using the iOS device's current calendar and time zone.

```bash
openclaw nodes invoke \
  --node "<iOS device name>" \
  --command health.summary \
  --params '{"period":"today"}' \
  --json
```

Agents can call the same command with the `nodes` tool:

```json
{
  "action": "invoke",
  "node": "<iOS device name>",
  "invokeCommand": "health.summary",
  "invokeParamsJson": "{\"period\":\"today\"}"
}
```

The summary payload contains:

| Field                    | Meaning                                       |
| ------------------------ | --------------------------------------------- |
| `period`                 | Always `today`                                |
| `startISO`               | Local start of day, encoded as an ISO instant |
| `endISO`                 | Request time, encoded as an ISO instant       |
| `timeZoneIdentifier`     | iOS device time-zone identifier               |
| `stepCount`              | Rounded cumulative steps                      |
| `sleepDurationMinutes`   | Deduplicated asleep time, clipped to today    |
| `restingHeartRateBpm`    | Average resting heart rate                    |
| `workoutCount`           | Workouts that started today                   |
| `workoutDurationMinutes` | Total duration of those workouts              |

Metric fields are optional and are omitted when HealthKit returns no readable
value. Sleep stages and overlapping sources are merged before duration is
calculated, so the same minute is not counted twice.

## Privacy behavior

- Aggregation happens on the iOS device. Raw samples do not leave the device.
- The requested aggregate leaves the device through your Gateway. When an agent
  requests it, the aggregate reaches the configured AI provider and may remain
  in chat history. A direct CLI invocation returns it to the CLI operator.
- OpenClaw requests read access only. It cannot add or modify Health data.
- OpenClaw reads HealthKit only when `health.summary` is invoked. There is no
  background health ingestion.
- HealthKit deliberately does not reveal whether read access was denied. A
  missing metric can mean denied access, no matching samples, or an unavailable
  data type. OpenClaw cannot distinguish those cases.
- The summary is for personal health and fitness context, not diagnosis or
  medical advice.

To stop sharing, return to **Apple Health Summaries** and tap **Turn Off Summaries**.
The iOS device then removes the Health capability and `health.summary` command from its node
surface. You can also remove `health.summary` from
`gateway.nodes.allowCommands` to close the Gateway side of the gate.

## Troubleshooting

### Command is not declared by the node

Confirm Apple Health summaries are enabled in the iOS app and the device is connected.
Run `openclaw nodes pending` and approve any capability update, then inspect
`openclaw nodes describe --node "<iOS device name>"` again.

### Command requires explicit opt-in

Add `health.summary` to `gateway.nodes.allowCommands`. Also check that
`gateway.nodes.denyCommands` does not contain it; the deny list wins.

### `HEALTH_ACCESS_DISABLED`

The app-side sharing switch is off. Enable **Apple Health Summaries** under
**Settings -> Permissions -> Apple Health** on the iOS device.

### Summary succeeds but metrics are missing

Open Apple's Health app and confirm that data exists for today. Review
OpenClaw's access in Apple's Health settings, but do not treat an empty result
as proof that access was denied: HealthKit intentionally hides that distinction.

### Older ranges fail

The command accepts only `{"period":"today"}`. Multi-day and historical
summaries are not supported.

## Related

- [iOS app](/platforms/ios)
- [Nodes](/nodes)
- [Gateway configuration reference](/gateway/configuration-reference#gateway)
- [Security audit](/gateway/security)
