// Covers broadcast frame-serialization failure: an unserializable payload must
// not consume per-client seqs (which would fire every client's gap detector and
// cause a synchronized reconnect storm) and must leave a server-side record.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      if (subsystem !== "gateway/broadcast") {
        return logger;
      }
      return { ...logger, error: warnSpy };
    },
  };
});

type RecordingSocket = {
  bufferedAmount: number;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  frames: Array<{ event: string; seq: number }>;
};

function makeClient(connId: string): { client: GatewayWsClient; socket: RecordingSocket } {
  const frames: Array<{ event: string; seq: number }> = [];
  const socket: RecordingSocket = {
    bufferedAmount: 0,
    close: vi.fn(),
    send: vi.fn((payload: string) => {
      const frame = JSON.parse(payload) as { event: string; seq: number };
      frames.push({ event: frame.event, seq: frame.seq });
    }),
    frames,
  };
  return {
    client: {
      socket: socket as unknown as GatewayWsClient["socket"],
      connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
      connId,
      usesSharedGatewayAuth: false,
    },
    socket,
  };
}

afterEach(() => {
  setVerbose(false);
  setLoggerOverride(null);
  resetLogger();
});

describe("broadcast serialization failures", () => {
  it("drops the event without consuming seqs when the payload cannot serialize", () => {
    warnSpy.mockClear();
    const first = makeClient("first");
    const second = makeClient("second");
    const clients = new Set([first.client, second.client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    broadcast("skills.changed", circular);

    // Neither socket saw the bad frame, and the failure is recorded once.
    expect(first.socket.send).not.toHaveBeenCalled();
    expect(second.socket.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("skills.changed");

    // The next good broadcast starts at seq 1 for every client: the dropped
    // event consumed no seq, so no gap detector fires.
    broadcast("skills.changed", { reason: "recovered" });
    expect(first.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
    expect(second.socket.frames).toEqual([{ event: "skills.changed", seq: 1 }]);
  });

  it("does not inspect agent log summaries for an ineligible outbound broadcast", () => {
    setVerbose(true);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const filtered = makeClient("filtered");
    filtered.client.connect.scopes = [];
    const { broadcast } = createGatewayBroadcaster({ clients: new Set([filtered.client]) });
    let dataReads = 0;
    const payload = {
      runId: "run-1",
      stream: "assistant",
      get data() {
        dataReads += 1;
        return { text: "not delivered" };
      },
    };

    broadcast("agent", payload);

    expect(filtered.socket.send).not.toHaveBeenCalled();
    expect(dataReads).toBe(0);
  });
});
