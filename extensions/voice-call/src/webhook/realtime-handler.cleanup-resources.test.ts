import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-support.js";

describe("RealtimeCallHandler physical registration ownership", () => {
  it.each(["adopted", "provisional"] as const)(
    "retains %s failed-close resources until explicit shutdown retry",
    async (phase) => {
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE native_state (value TEXT); INSERT INTO native_state VALUES ('retained')",
      );
      let allowClose = false;
      let attempts = 0;
      let released = false;
      const bridge = createBridge(() => {
        attempts += 1;
        expect(db.prepare("SELECT value FROM native_state").get()?.value).toBe("retained");
        if (!allowClose) {
          throw new Error("native provider close failed");
        }
      });
      const provider = makeRealtimeProvider((request) => {
        if (phase === "provisional") {
          request.onClose?.("error");
        }
        return bridge;
      });
      const registration: ResolveRealtimeCallRegistration = () => ({
        agentId: "main",
        instructions: "Synthetic",
        provider,
        providerConfig: {},
        runWithProviderResources: (operation) => operation(),
        releaseProviderResources() {
          if (!released) {
            released = true;
            db.close();
          }
        },
      });
      const { handler, call } = createCarrierLifecycleHarness(() => bridge, {
        resolveCallRegistration: registration,
      });
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-cleanup", callSid: call.providerCallId },
          }),
        );
        if (phase === "adopted") {
          await vi.waitFor(() =>
            expect(handler.speak(call.callId, "Synthetic").success).toBe(true),
          );
          await handler.close().catch(() => {});
        } else {
          await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
        }
        expect(db.isOpen).toBe(true);
        expect(released).toBe(false);
        await expect(handler.close()).rejects.toThrow("native provider close failed");
        allowClose = true;
        await handler.close();
        expect(released).toBe(true);
        expect(db.isOpen).toBe(false);
      } finally {
        allowClose = true;
        ws.terminate();
        await handler.close().catch(() => {});
        await server.close();
        if (db.isOpen) {
          db.close();
        }
      }
    },
  );

  it("binds later speech and carrier audio operations to their native provider context", async () => {
    const context = new AsyncLocalStorage<DatabaseSync>();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE operations (name TEXT)");
    const record = (name: string) => {
      const connection = context.getStore();
      if (!connection) {
        throw new Error("native provider context missing");
      }
      connection.prepare("INSERT INTO operations VALUES (?)").run(name);
    };
    const bridge = createBridge(() => record("close"), {
      triggerGreeting: () => record("speech"),
      sendAudio: () => record("audio"),
      setMediaTimestamp: () => record("timestamp"),
      acknowledgeMark: () => record("mark"),
    });
    const provider = makeRealtimeProvider(() => bridge);
    const registration: ResolveRealtimeCallRegistration = () => ({
      agentId: "main",
      instructions: "Synthetic",
      provider,
      providerConfig: {},
      runWithProviderResources: (operation) => context.run(db, operation),
      releaseProviderResources() {},
    });
    const { handler, call } = createCarrierLifecycleHarness(() => bridge, {
      resolveCallRegistration: registration,
    });
    const { server, ws } = await connectCarrierStream(handler);
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-scope", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() =>
        expect(handler.speak(call.callId, "Synthetic").error).not.toBe(
          "No active realtime bridge for call",
        ),
      );
      expect(handler.speak(call.callId, "Synthetic")).toEqual({ success: true });
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.from([1, 2]).toString("base64"), timestamp: "12" },
        }),
      );
      ws.send(JSON.stringify({ event: "mark", mark: { name: "synthetic" } }));
      await vi.waitFor(() =>
        expect(
          db
            .prepare("SELECT name FROM operations")
            .all()
            .map((row) => row.name),
        ).toEqual(expect.arrayContaining(["audio", "timestamp", "mark"])),
      );
      await handler.close();
      expect(db.prepare("SELECT name FROM operations WHERE name = 'close'").all()).toHaveLength(1);
    } finally {
      ws.terminate();
      await handler.close().catch(() => {});
      await server.close();
      db.close();
    }
  });
});
