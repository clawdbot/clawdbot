import { describe, expect, it, vi } from "vitest";
import {
  createBroker,
  createRequest,
  createResponseHarness,
  emitSideband,
} from "./realtime-quicksilver.test-helpers.js";

describe("GPT-Live browser session lifecycle", () => {
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
