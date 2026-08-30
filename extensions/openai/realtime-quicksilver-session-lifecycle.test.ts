import { describe, expect, it, vi } from "vitest";
import {
  createBroker,
  createRequest,
  createResponseHarness,
  emitSideband,
  type FakeSocket,
} from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live browser session lifecycle", () => {
  it.each([
    {
      name: "socket error",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
    },
    {
      name: "abnormal close",
      trigger: (socket: FakeSocket) => socket.close(1006, "connection lost"),
      failed: true,
    },
    {
      name: "throwing error callback",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
      throwingCallback: "error",
    },
    {
      name: "throwing close callback",
      trigger: (socket: FakeSocket) => socket.emit("error", new Error("connection lost")),
      failed: true,
      throwingCallback: "close",
    },
    {
      name: "close without status",
      trigger: (socket: FakeSocket) => socket.emit("close"),
      failed: true,
    },
    {
      name: "fatal provider error",
      trigger: (socket: FakeSocket) =>
        emitSideband(socket, { type: "error", error: { code: "invalid_token" } }),
      failed: true,
    },
    {
      name: "binary protocol failure",
      trigger: (socket: FakeSocket) => emitSideband(socket, { unexpected: true }, true),
      failed: true,
    },
    {
      name: "normal close",
      trigger: (socket: FakeSocket) => socket.close(1000, "complete"),
      failed: false,
    },
  ])(
    "reports $name once and releases the active browser owner",
    async ({ trigger, failed, throwingCallback }) => {
      const { realtime, sockets, runAgentConsult } = createBroker();
      const notifications: string[] = [];
      const onError = vi.fn(() => {
        notifications.push("error");
        void realtime.broker.cancelBrowserSession(reservation);
        if (throwingCallback === "error") {
          throw new Error("host error callback failed");
        }
      });
      const onClose = vi.fn((reason: string) => {
        notifications.push(`close:${reason}`);
        if (throwingCallback === "close") {
          throw new Error("host close callback failed");
        }
      });
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-test",
          runAgentConsult,
          gatewayControl: { bindBridge: vi.fn(), onError, onClose },
        },
        { type: "api-key", token: "platform-key" },
      );
      try {
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        await realtime.handler(
          createRequest({ token: reservation.clientSecret }),
          createResponseHarness().res,
        );
        const socket = sockets[0];
        if (!socket) {
          throw new Error("Expected sideband socket");
        }
        trigger(socket);
        expect(socket.closed).toBe(true);
        expect(realtime.getSessionCounts()).toEqual({
          pending: 0,
          inFlight: 0,
          active: 0,
          reservations: 0,
        });
        await realtime.cleanup();
        socket.emit("error", new Error("late socket error"));
        socket.emit("close", 1006, Buffer.from("late close"));
        emitSideband(socket, {
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "late",
            content: [{ type: "input_text", text: "must not run" }],
          },
        });

        expect(notifications).toEqual(failed ? ["error", "close:error"] : ["close:completed"]);
        expect(onError).toHaveBeenCalledTimes(failed ? 1 : 0);
        expect(onClose).toHaveBeenCalledOnce();
        expect(runAgentConsult).not.toHaveBeenCalled();
      } finally {
        await realtime.cleanup();
      }
    },
  );

  it("releases browser transport while accepted delegation work finishes without late delivery", async () => {
    let finishConsult!: (value: { text: string }) => void;
    let consultSignal: AbortSignal | undefined;
    const result = new Promise<{ text: string }>((resolve) => {
      finishConsult = resolve;
    });
    const runAgentConsult = vi.fn(async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
      consultSignal = signal;
      return await result;
    });
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-test", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      const delegation = {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "accepted-delegation",
          content: [{ type: "input_text", text: "Finish this task" }],
        },
      };
      emitSideband(socket, delegation);
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());

      await realtime.broker.cancelBrowserSession(reservation);
      expect(socket.closed).toBe(true);
      expect(realtime.getSessionCounts()).toEqual({
        pending: 0,
        inFlight: 0,
        active: 0,
        reservations: 0,
      });
      expect(consultSignal?.aborted).toBe(false);
      emitSideband(socket, { ...delegation, item: { ...delegation.item, id: "late-delegation" } });
      finishConsult({ text: "Finished after browser close" });
      await result;
      await Promise.resolve();
      expect(runAgentConsult).toHaveBeenCalledOnce();
      expect(socket.sent.some((payload) => payload.includes("Finished after browser close"))).toBe(
        false,
      );
    } finally {
      finishConsult({ text: "Finished" });
      await realtime.cleanup();
    }
  });
});
