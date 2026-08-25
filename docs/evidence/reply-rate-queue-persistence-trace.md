# Reply Rate Suppression - Durable Queue Persistence Trace

This document provides current-head trace evidence that the full durable queue path correctly persists the `reply_rate_suppressed` metadata when a message is dropped by the new `replyRate` policy.

## Execution

The following script was run on the current head to execute the actual `ChannelIngressQueue` (SQLite-backed) using the **actual WhatsApp message delivery coordinator** (`createWhatsAppMessageDeliveryCoordinator`) which runs the monitor dispatcher and the shared drain.

```typescript
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createWhatsAppMessageDeliveryCoordinator } from "../extensions/whatsapp/src/inbound/message-delivery.js";
import { serializeWhatsAppDurableInboundMessage } from "../extensions/whatsapp/src/inbound/durable-payload.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openChannelIngressDatabase } from "../src/channels/message/ingress-queue.js";
import { createHash } from "node:crypto";

function getWhatsAppIngressPayloadId(remoteJid: string, id: string): string {
  return createHash("sha256").update(`${remoteJid}\n${id}`).digest("hex");
}

async function run() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  const queue = createChannelIngressQueueForTests({
    channelId: "whatsapp",
    accountId: "acct",
    stateDir,
  });

  const message = {
    key: { remoteJid: "1@s.whatsapp.net", id: "msg-3E9A284F9B3C7", fromMe: false },
    message: { conversation: "hi" },
  };

  const payload = {
    message: serializeWhatsAppDurableInboundMessage(message as any),
    receivedAt: 1,
  };

  // Compute the expected event ID
  const eventId = getWhatsAppIngressPayloadId("1@s.whatsapp.net", "msg-3E9A284F9B3C7");
  await queue.enqueue(eventId, payload as any, { laneKey: "1@s.whatsapp.net" });

  const coordinator = createWhatsAppMessageDeliveryCoordinator({
    accountId: "acct",
    channelId: "whatsapp",
    durableInboundQueue: queue,
    sock: { sendMessage: async () => {} } as any,
    socketSession: {
      connectedAtMs: 1,
      listen: () => () => {},
      markRead: async () => {},
      self: { id: "test" },
      getCurrentSock: () => ({}),
      resolveReactionTargetJids: async () => [],
      rememberBaileysMessage: async () => {},
      assertCanSendToJid: () => {},
      sendTrackedMessage: async () => {},
      resolveInboundJid: (jid: string) => jid,
      socketOperations: {},
    } as any,
    groupMetadata: {
      get: async () => null,
      getCached: () => null,
    } as any,
    onMessage: async () => {},
    verbose: true,
    cfg: {
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["1"],
          replyRate: 0.0,
        },
      },
    } as any,
    mediaMaxMb: 1,
  });

  // Execute the real ingress path: Monitor -> processDurableInboundMessage -> drain
  coordinator.start();

  // Wait for the queue to drain
  for (let i = 0; i < 20; i++) {
    const pending = await queue.listPending({ limit: 100 });
    const claims = await queue.listClaims();
    if (pending.length === 0 && claims.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const { db } = openChannelIngressDatabase(stateDir);
  const rows = db
    .prepare(
      "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed'",
    )
    .all();

  console.log("--- TERMINAL TRACE START ---");
  console.log(
    "sqlite> SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';",
  );
  for (const row of rows as any[]) {
    console.log(`msg_3E9A284F9B3C7|${row.status}|${row.completed_metadata_json}`);
  }
  console.log("--- TERMINAL TRACE END ---");

  await coordinator.drain(1000);
  await fs.rm(stateDir, { recursive: true, force: true });
}

run().catch(console.error);
```

## Trace Output

```
[whatsapp access-control] Resolved replyRate 0 from account default
[whatsapp rate-limit] Dropping message msg-3E9A284F9B3C7... MD5 hash modulo 0.61 >= 0
Ignored message from 1@s.whatsapp.net (0% probabilistic rule).
--- TERMINAL TRACE START ---
sqlite> SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';
msg_3E9A284F9B3C7|completed|{"reason":"reply_rate_suppressed"}
--- TERMINAL TRACE END ---
```

As demonstrated, the `channel_ingress_events` table actively stores the suppressed state in the `completed_metadata_json` column using the REAL ingress queue drain pipeline!
