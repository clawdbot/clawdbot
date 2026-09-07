import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import {
  connectCarrierStream,
  createBridge,
  createCarrierLifecycleHarness,
  makeRealtimeProvider,
} from "./realtime-handler.lifecycle.test-support.js";

describe("RealtimeCallHandler registration resources", () => {
  it.each(["connection", "submission"] as const)(
    "retains native provider resources when the carrier closes during %s",
    async (phase) => {
      const db = new DatabaseSync(":memory:");
      db.exec("CREATE TABLE connection (value TEXT); INSERT INTO connection VALUES ('retained')");
      const entered = createDeferred<void>();
      const finish = createDeferred<void>();
      const connected = createDeferred<void>();
      let accepted: Promise<unknown> | undefined;
      let released = false;
      const pendingOperation = async () => {
        entered.resolve();
        await finish.promise;
        try {
          expect(db.prepare("SELECT value FROM connection").get()?.value).toBe("retained");
        } finally {
          connected.resolve();
        }
      };
      const bridge = createBridge(
        () => {},
        phase === "connection"
          ? { connect: pendingOperation }
          : { submitToolResult: pendingOperation },
      );
      let providerRequest: RealtimeVoiceBridgeCreateRequest | undefined;
      const provider = makeRealtimeProvider((request) => {
        providerRequest = request;
        return bridge;
      });
      const resolveCallRegistration: ResolveRealtimeCallRegistration = () => ({
        agentId: "main",
        instructions: "Be helpful.",
        provider,
        providerConfig: {},
        runWithProviderResources(operation) {
          const result = operation();
          if (result instanceof Promise) {
            accepted = result;
          }
          return result;
        },
        releaseProviderResources() {
          if (released) {
            return;
          }
          released = true;
          if (accepted) {
            void accepted.then(
              () => db.close(),
              () => db.close(),
            );
          } else {
            db.close();
          }
        },
      });
      const { call, handler } = createCarrierLifecycleHarness(() => bridge, {
        resolveCallRegistration,
      });
      const { server, ws } = await connectCarrierStream(handler);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-native", callSid: call.providerCallId },
          }),
        );
        if (phase === "submission") {
          await vi.waitFor(() => expect(providerRequest).toBeDefined());
          providerRequest?.onToolCall?.({
            itemId: "item",
            callId: "call",
            name: "synthetic",
            args: {},
          });
        }
        await entered.promise;
        await handler.close();
        expect(released).toBe(true);
        expect(db.isOpen).toBe(true);
        finish.resolve();
        await connected.promise;
        await vi.waitFor(() => expect(db.isOpen).toBe(false));
      } finally {
        finish.resolve();
        await connected.promise;
        ws.terminate();
        await handler.close();
        await server.close();
        if (db.isOpen) {
          db.close();
        }
      }
    },
  );
});
