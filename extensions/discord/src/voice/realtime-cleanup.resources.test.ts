import { DatabaseSync } from "node:sqlite";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

defineDiscordVoiceTests(({ expect, it, vi, createJoinedAgentProxyFixture, lastRealtimeBridge }) => {
  it.each(["leave", "destroy", "replacement"] as const)(
    "keeps failed provider cleanup reachable through manager %s",
    async (operation) => {
      const adapter = await import("./realtime-provider.runtime.js");
      const acquire = adapter.acquireConfiguredRealtimeVoiceProvider;
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE native_state (value TEXT); INSERT INTO native_state VALUES ('retained')",
      );
      const acquisition = vi.spyOn(adapter, "acquireConfiguredRealtimeVoiceProvider");
      acquisition.mockImplementationOnce((...args) => {
        const resolved = acquire(...args);
        return {
          ...resolved,
          release(pending) {
            resolved.release(pending);
            if (pending) {
              void pending.then(
                () => db.close(),
                () => db.close(),
              );
            } else {
              db.close();
            }
          },
        };
      });
      const { entry, manager } = await createJoinedAgentProxyFixture();
      const provider = lastRealtimeBridge().session;
      let allowCleanup = false;
      provider.close.mockImplementation(() => {
        expect(db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
        if (!allowCleanup) {
          throw new Error("provider cleanup failed");
        }
      });
      try {
        await expect(manager.leave({ guildId: "g1" })).rejects.toThrow("provider cleanup failed");
        expect(db.isOpen).toBe(true);
        const retry = () =>
          operation === "destroy"
            ? manager.destroy()
            : operation === "replacement"
              ? manager.join({ guildId: entry.guildId, channelId: entry.channelId })
              : manager.leave({ guildId: "g1" });
        await expect(retry()).rejects.toThrow("provider cleanup failed");
        expect(db.isOpen).toBe(true);
        allowCleanup = true;
        await retry();
        await vi.waitFor(() => expect(db.isOpen).toBe(false));
        expect(provider.close).toHaveBeenCalledTimes(3);
      } finally {
        allowCleanup = true;
        await manager.destroy();
        acquisition.mockRestore();
        if (db.isOpen) {
          db.close();
        }
      }
    },
  );
});
