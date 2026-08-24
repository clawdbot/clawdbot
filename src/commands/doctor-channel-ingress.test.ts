// Doctor channel ingress tests cover dead-letter visibility and recovery guidance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { noteChannelIngressDeadLetters } from "./doctor-channel-ingress.js";

describe("noteChannelIngressDeadLetters", () => {
  it("mentions affected channel accounts and the inspection command", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-ingress-"));
    try {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });
      await queue.enqueue("event-1", { text: "recover me" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const noteFn = vi.fn();

      noteChannelIngressDeadLetters({ stateDir, noteFn });

      expect(noteFn).toHaveBeenCalledWith(
        expect.stringContaining("telegram/ops: 1 dead-lettered ingress event"),
        "Channel ingress",
      );
      expect(noteFn.mock.calls[0]?.[0]).toContain(
        "openclaw channels dead-letters list --channel telegram --account ops",
      );
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
