---
name: channel-message-flows
description: "Use when running QA Lab channel message flow evidence."
---

# Channel Message Flows

Use this from the OpenClaw repo root to run the QA Lab evidence for Telegram
draft/final delivery sequencing. The behavior is owned by one transport-native
QA flow that can run through QA Channel or Crabline Telegram.

## QA Scenario

Run the scenario through QA Lab:

```bash
OPENCLAW_BUILD_PRIVATE_QA=1 node scripts/run-node.mjs qa suite \
  --provider-mode mock-openai \
  --scenario channel-message-flows \
  --channel-driver qa-channel
```

Run the same YAML through the real Telegram plugin against Crabline's local
provider server:

```bash
OPENCLAW_BUILD_PRIVATE_QA=1 node scripts/run-node.mjs qa suite \
  --provider-mode mock-openai \
  --scenario channel-message-flows \
  --channel-driver crabline \
  --channel telegram
```

## References

- `qa/scenarios/channels/channel-message-flows.yaml`
- `extensions/qa-channel/src/inbound.ts`
- `extensions/qa-lab/src/qa-transport.ts`
- `extensions/qa-lab/src/crabline-transport.ts`
- `extensions/telegram/src/draft-stream.ts`

The scenario covers `channels.streaming` as primary evidence and
`runtime.delivery` as secondary evidence.
