// Read-only ingress listing tests cover access that must not create shared state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

describe("read-only listing access", () => {
  it("lists without creating the shared state database", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-readonly-"));
    try {
      const sqlitePath = path.join(stateDir, "state", "openclaw.sqlite");
      await expect(fs.access(sqlitePath)).rejects.toThrow();

      const reader = createChannelIngressQueue<{ text: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
        access: "read-only",
      });
      // The read-only opener never creates, migrates or configures the file, so a
      // caller that runs before it owns the state cannot bring the store into being.
      expect(await reader.listPending({ limit: "all" })).toEqual([]);
      expect(await reader.listClaims()).toEqual([]);
      expect(await reader.listFailed?.({ limit: "all" })).toEqual([]);
      await expect(fs.access(sqlitePath)).rejects.toThrow();

      // A read-write queue is what actually creates it, and the read-only reader then
      // sees the same rows - so the empty results above are the access mode, not a
      // broken reader.
      await createChannelIngressQueue<{ text: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
      }).enqueue("evt-1", { text: "hello" });
      await fs.access(sqlitePath);
      closeOpenClawStateDatabaseForTest();

      const after = createChannelIngressQueue<{ text: string }>({
        channelId: "line",
        accountId: "default",
        stateDir,
        access: "read-only",
      });
      expect((await after.listPending({ limit: "all" })).map((row) => row.id)).toEqual(["evt-1"]);
    } finally {
      closeOpenClawStateDatabaseForTest();
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
