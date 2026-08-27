import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannelIngressQueueForTests } from "../../src/plugin-sdk/plugin-state-test-runtime.js";

async function run() {
  const stateDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

  try {
    const queue = createChannelIngressQueueForTests({
      channelId: "whatsapp",
      accountId: "default",
      stateDir,
    });

    const eventId = "9b12854cf60ad7fb9a263ba8b394144365cd6c7017edb0fc84dd00edddb0e879";

    // Simulate inbound message enqueue
    await queue.enqueue(
      eventId,
      { body: "test-suppressed-message" },
      { metadata: { source: "test" } },
    );

    // Simulate replyRate policy suppressing the message and setting completion metadata
    await queue.complete(eventId, {
      metadata: { reason: "reply_rate_suppressed" },
    });

    const dbPath = join(stateDir, "state", "openclaw.sqlite");
    const query =
      "SELECT event_id, status, completed_metadata_json FROM channel_ingress_events WHERE status = 'completed';";

    console.log("Querying sqlite database directly:");
    console.log(`$ sqlite3 queue.db "${query}"`);

    const output = execSync(`sqlite3 -json "${dbPath}" "${query}"`).toString();
    console.log(output);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

run().catch(console.error);
