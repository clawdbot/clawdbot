---
summary: "Optional automatic work journal built from periodic screen snapshots"
read_when:
  - You want a Dayflow-style timeline of your day in the Control UI
  - You are enabling or configuring the bundled Logbook plugin
  - You want standup summaries or day recall grounded in screen activity
title: "Logbook plugin"
---

The Logbook plugin turns screen activity into an automatic work journal. It
captures periodic screen snapshots from a paired node, summarizes them into
timestamped observations, and builds timeline cards in the
[Control UI](/web/control-ui). It can also generate daily standup notes and
answer questions about a tracked day.

OpenClaw-owned state stays on the Gateway under `<state-dir>/logbook/`, but
model processing is not necessarily local. Sampled screenshots go to the
configured vision route; observations and timeline text go to the default
agent model. Use local model routes for both stages if screen content and
derived activity text must stay on the machine.

Logbook is bundled and disabled by default. Enabling the plugin opts the
Gateway into screen capture because `captureEnabled` defaults to `true`.

## Before you begin

You need:

- A connected node that exposes `screen.snapshot` or `logbook.snapshot`. The
  macOS app node needs Screen Recording permission. A headless macOS node host
  (`openclaw node host run`) gets the plugin-provided `logbook.snapshot`
  command backed by the system `screencapture` tool.
- The bundled Codex plugin enabled and authenticated. Codex currently provides
  the structured image-extraction contract Logbook requires. Sign in with
  `openclaw models auth login --provider openai`; see
  [Codex harness](/plugins/codex-harness) for other auth paths.
- A working default agent model. Logbook uses it to synthesize cards, standup
  notes, and day Q&A after the vision pass.

## Quickstart

Enable the Codex and Logbook plugins:

```bash
openclaw plugins enable codex
openclaw plugins enable logbook
```

Configure an explicit vision model for deterministic startup:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
      logbook: {
        enabled: true,
        config: {
          visionModel: "codex/gpt-5.6-sol",
        },
      },
    },
  },
}
```

If you use `plugins.allow`, include both `codex` and `logbook`. Restart the
Gateway after changing plugin configuration, then inspect the registrations
and open the dashboard:

```bash
openclaw gateway restart
openclaw plugins inspect logbook --runtime --json
openclaw nodes status --connected
openclaw nodes describe --node <idOrNameOrIp>
openclaw dashboard
```

The node description must include `screen.snapshot` or `logbook.snapshot`.
Headless nodes advertise `logbook.snapshot` only after the plugin is active.
See [Node troubleshooting](/nodes/troubleshooting) if the command is missing.

The Logbook tab appears only for an enabled plugin and an `operator.write`
Control UI session. The status row should show **Capturing** without an error.
A timeline card appears when the analysis window closes, or you can select
**Analyze now** after activity has been captured.

## How it works

1. **Capture**: every `captureIntervalSeconds` (default 30s), Logbook invokes
   the selected node's capture command and stores a scaled JPEG frame.
   Consecutive identical frames are marked idle and excluded from analysis.
2. **Observe**: once an analysis window (default 15 minutes) elapses, the
   plugin samples up to 16 active frames and sends them to the vision model,
   which returns timestamped activity observations ("VS Code: editing
   store.ts, fixing a type error"). A capture gap longer than two minutes or
   local midnight also closes the current window.
3. **Synthesize**: observations plus the last 45 minutes of existing cards are
   revised into timeline cards (10-60 minutes each) with a title, summary,
   category, main app, and any brief distractions.
4. **Prune**: frames older than `retentionDays` (default 14) are deleted.
   Cards, observations, and cached standups are kept.

Day boundaries and timeline clocks use the Gateway's local timezone, not the
browser's timezone. Frames and the SQLite timeline database live under
`<state-dir>/logbook/`.

## Model and data flow

Logbook uses two separate model routes:

| Stage            | Data sent                                                 | Model route                                                       |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Observe          | Up to 16 sampled JPEG frames plus their capture times     | `visionModel`, or a compatible borrowed `tools.media` Codex entry |
| Synthesize cards | Timestamped observations and recent timeline cards        | Default agent model through the plugin LLM runtime                |
| Generate standup | Cards for the selected day and previous day               | Default agent model through the plugin LLM runtime                |
| Ask your day     | The question, selected-day cards, and recent observations | Default agent model through the plugin LLM runtime                |

The full SQLite database is not sent to either model. Raw screenshots go only
to the observation stage; card synthesis, standup, and Q&A receive derived
text.

## Configuration

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
      logbook: {
        enabled: true,
        config: {
          captureEnabled: true,
          captureIntervalSeconds: 30,
          analysisIntervalMinutes: 15,
          nodeId: "my-mac",
          screenIndex: 0,
          maxWidth: 1440,
          visionModel: "codex/gpt-5.6-sol",
          retentionDays: 14,
        },
      },
    },
  },
}
```

All Logbook config keys are optional. Numeric values are rounded to integers
and clamped to the supported range.

| Key                       | Default | Range or values         | Behavior                                                                                     |
| ------------------------- | ------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `captureEnabled`          | `true`  | boolean                 | Persistent master switch for new snapshots; the timeline remains available when `false`      |
| `captureIntervalSeconds`  | `30`    | `5`-`600`               | Delay between capture attempts                                                               |
| `analysisIntervalMinutes` | `15`    | `3`-`120`               | Target observation window; gaps and midnight can close it earlier                            |
| `nodeId`                  | unset   | node id or display name | Pins capture to one connected node; matching is case-insensitive                             |
| `screenIndex`             | `0`     | `0`-`16`                | Zero-based display index                                                                     |
| `maxWidth`                | `1440`  | `480`-`3840`            | Requested capture size cap; headless macOS applies it to the largest dimension               |
| `visionModel`             | unset   | `provider/model`        | Explicit structured route; malformed refs pause analysis, unsupported providers fail batches |
| `retentionDays`           | `14`    | `1`-`365`               | Deletes old frames; cards, observations, and standups remain                                 |

Without `nodeId`, Logbook prefers a connected app node exposing
`screen.snapshot`, then falls back to a headless node exposing
`logbook.snapshot`. In an unpinned setup, a failed node rotates behind other
eligible nodes. The dashboard pause toggle is session-only and resets when the
Gateway restarts; use `captureEnabled: false` for a persistent stop.

### Vision model selection

Logbook resolves the observation model in this order:

1. `plugins.entries.logbook.config.visionModel`
2. the first image-capable Codex entry under `tools.media.models`

Other media providers are skipped because they do not currently expose the
structured extraction contract Logbook requires. Setting
`tools.media.image.enabled: false` disables borrowed media defaults, but an
explicit Logbook `visionModel` still applies.

## Dashboard tab

- **Timeline**: expandable cards per activity with category colors, the main
  app, distraction chips, and a snapshot keyframe.
- **Day at a glance**: focus ratio, category breakdown, top apps.
- **Daily standup**: turns yesterday plus today into a ready-to-paste update.
- **Ask your day**: natural-language questions answered from the tracked
  timeline ("when did I review the gateway PR?").
- **Analyze now**: closes the current capture window immediately instead of
  waiting for the analysis interval.

## Gateway methods

Logbook registers these Gateway RPC methods:

| Method                | Parameters               | Scope            | Result                                                                   |
| --------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------ |
| `logbook.status`      | none                     | `operator.read`  | Capture, analysis, model, node, Gateway day, and Gateway timezone status |
| `logbook.days`        | none                     | `operator.read`  | Days with timeline-card counts and card time bounds                      |
| `logbook.timeline`    | `{ day?: "YYYY-MM-DD" }` | `operator.read`  | Derived cards and day statistics; defaults to the Gateway's current day  |
| `logbook.frames`      | `{ startMs, endMs }`     | `operator.write` | Frame metadata in the requested epoch-millisecond range                  |
| `logbook.frame`       | `{ frameId }`            | `operator.write` | One raw JPEG frame as base64                                             |
| `logbook.standup`     | `{ day?, refresh? }`     | `operator.write` | Cached or regenerated standup text for a day                             |
| `logbook.ask`         | `{ day?, question }`     | `operator.write` | Timeline-grounded answer for a day                                       |
| `logbook.capture.set` | `{ paused }`             | `operator.write` | Session-only pause state and updated status                              |
| `logbook.analyze.now` | none                     | `operator.write` | Starts pending analysis, or returns a reason it could not start          |

The read methods return operational state or derived text. Raw screenshot
pixels, model-spending actions, and runtime mutations require
`operator.write`. The Control UI tab also requires `operator.write` because it
exposes those actions and raw frame previews; a read-only client can still call
the derived-text methods directly.

## Privacy notes

- Snapshots can contain anything on screen, including secrets. Frames never
  leave the machine except as sampled input to the configured observation
  model.
- Observations, recent cards, and questions can leave the machine through the
  default agent model during card synthesis, standup generation, or Q&A. Apply
  the provider's data-handling policy to both model routes.
- Use local routes for both the structured observation model and default agent
  model when you need a fully local pipeline.
- Frames, the timeline database, and temporary captures are written with
  owner-only file permissions.
- Adding `screen.snapshot` to `gateway.nodes.commands.deny` is the
  screen-capture kill switch: it blocks app-node capture and Logbook's own
  `logbook.snapshot` command alike.
- Setting `tools.media.image.enabled: false` also stops Logbook from borrowing
  the media image models for analysis; only an explicit `visionModel` in the
  plugin config is used then.

## Troubleshooting

### The Logbook tab is missing

Check all three gates:

1. `openclaw plugins list --enabled` includes `logbook`.
2. The Gateway restarted after the plugin or allowlist change.
3. The Control UI connection has `operator.write`; read-only sessions do not
   receive the interactive tab descriptor.

If `plugins.allow` is set, it must include both `logbook` and `codex` for the
recommended configuration.

### Capture reports an error

```bash
openclaw nodes status --connected
openclaw nodes describe --node <idOrNameOrIp>
openclaw logs --follow
```

- Confirm the node exposes `screen.snapshot` or `logbook.snapshot`.
- Grant Screen Recording permission on the capture Mac.
- If `nodeId` is configured, confirm it matches the node id or display name.
- Check that `gateway.nodes.commands.deny` does not contain
  `screen.snapshot`.

After three consecutive failures, Logbook backs off for ten capture ticks and
then retries. An unpinned setup can rotate to another eligible node.

### Captures succeed but no cards appear

- A **Model missing** status means no compatible structured vision route was
  found. Enable and authenticate the Codex plugin, or set a valid explicit
  `visionModel`. Captured frames remain pending while the model is missing and
  can be analyzed after configuration is fixed.
- Wait for `analysisIntervalMinutes`, or select **Analyze now** after activity
  has been captured.
- Consecutive identical frames are idle evidence and do not enter analysis
  batches. Change the visible screen before testing.
- If the latest batch shows an error, fix the model or auth problem and select
  **Analyze now**. Failed batches are retried only on that explicit action to
  avoid repeated model spend.

## Related

- [Manage plugins](/plugins/manage-plugins)
- [Codex harness](/plugins/codex-harness)
- [Media understanding](/nodes/media-understanding)
- [Nodes](/nodes)
- [Node troubleshooting](/nodes/troubleshooting)
- [Control UI](/web/control-ui)
