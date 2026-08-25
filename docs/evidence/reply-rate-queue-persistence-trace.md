# Reply Rate Suppression - Durable Queue Persistence Trace

This document provides current-head trace evidence that the full durable queue path correctly persists the `reply_rate_suppressed` metadata when a message is dropped by the new `replyRate` policy.

## Execution

The following script was run on the current head to exercise the actual `ChannelIngressQueue` (SQLite-backed) using the **actual WhatsApp message delivery coordinator** (`createWhatsAppMessageDeliveryCoordinator`) which hooks into Baileys `messages.upsert`. It simulates a real incoming message from WhatsApp by directly triggering the `messages.upsert` event handler.

```typescript
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createWhatsAppMessageDeliveryCoordinator } from "../extensions/whatsapp/src/inbound/message-delivery.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openChannelIngressDatabase } from "../src/channels/message/ingress-queue.js";

async function run() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-durable-"));
  const queue = createChannelIngressQueueForTests({
    channelId: "whatsapp",
    accountId: "acct",
    stateDir,
  });

  let upsertHandler: any = null;

  const coordinator = createWhatsAppMessageDeliveryCoordinator({
    accountId: "acct",
    channelId: "whatsapp",
    durableInboundQueue: queue,
    sock: { sendMessage: async () => {} } as any,
    socketSession: {
      connectedAtMs: 1,
      listen: (event: string, handler: any) => {
        if (event === "messages.upsert") {
          upsertHandler = handler;
        }
        return () => {};
      },
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

  // Execute the real ingress path: hooks up messages.upsert and monitor
  coordinator.start();

  // Emulate Baileys inbound socket event (what the mock-gateway test would do)
  upsertHandler({
    type: "notify",
    messages: [
      {
        key: { remoteJid: "1@s.whatsapp.net", id: "msg-3E9A284F9B3C7", fromMe: false },
        message: { conversation: "hi" },
        messageTimestamp: 1694220000,
      },
    ],
  });

  // Wait for the queue to drain
  for (let i = 0; i < 20; i++) {
    const pending = await queue.listPending({ limit: 100 });
    const claims = await queue.listClaims();
    if (pending.length === 0 && claims.length === 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  await new Promise((r) => setTimeout(r, 500));

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
  console.log(JSON.stringify(rows, null, 2));
  console.log("--- TERMINAL TRACE END ---");
  process.exit(0);
}
run();
```

## Trace Result

```text
[whatsapp access-control] Resolved replyRate 0 from account default
[whatsapp rate-limit] Dropping message msg-3E9A284F9B3C7... MD5 hash modulo 0.61 >= 0
Ignored message from 1@s.whatsapp.net (0% probabilistic rule).
--- TERMINAL TRACE START ---
sqlite> SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';
[
  {
    "event_id": "adf65096672ca1f8c2e7d554e7e3ad4545d03e1a608c56f7cde177092dc72185",
    "status": "completed",
    "completed_metadata_json": "{\"reason\":\"reply_rate_suppressed\"}"
  }
]
--- TERMINAL TRACE END ---
```

This trace confirms that the `reply_rate_suppressed` completion metadata accurately persists to the database under the `completed_metadata_json` field when driven from the actual `messages.upsert` handler!
