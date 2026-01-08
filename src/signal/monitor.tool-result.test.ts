import { beforeEach, describe, expect, it, vi } from "vitest";

import { monitorSignalProvider } from "./monitor.js";

const sendMock = vi.fn();
const replyMock = vi.fn();
const updateLastRouteMock = vi.fn();
let config: Record<string, unknown> = {};
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => config,
  };
});

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: (...args: unknown[]) => replyMock(...args),
}));

vi.mock("./send.js", () => ({
  sendMessageSignal: (...args: unknown[]) => sendMock(...args),
}));

vi.mock("../pairing/pairing-store.js", () => ({
  readProviderAllowFromStore: (...args: unknown[]) =>
    readAllowFromStoreMock(...args),
  upsertProviderPairingRequest: (...args: unknown[]) =>
    upsertPairingRequestMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
  updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
}));

const streamMock = vi.fn();
const signalCheckMock = vi.fn();
const signalRpcRequestMock = vi.fn();

vi.mock("./client.js", () => ({
  streamSignalEvents: (...args: unknown[]) => streamMock(...args),
  signalCheck: (...args: unknown[]) => signalCheckMock(...args),
  signalRpcRequest: (...args: unknown[]) => signalRpcRequestMock(...args),
}));

vi.mock("./daemon.js", () => ({
  spawnSignalDaemon: vi.fn(() => ({ stop: vi.fn() })),
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  config = {
    messages: { responsePrefix: "PFX" },
    signal: { autoStart: false, dmPolicy: "open", allowFrom: ["*"] },
    routing: { allowFrom: [] },
  };
  sendMock.mockReset().mockResolvedValue(undefined);
  replyMock.mockReset();
  updateLastRouteMock.mockReset();
  streamMock.mockReset();
  signalCheckMock.mockReset().mockResolvedValue({});
  signalRpcRequestMock.mockReset().mockResolvedValue({});
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock
    .mockReset()
    .mockResolvedValue({ code: "PAIRCODE", created: true });
});

describe("monitorSignalProvider tool results", () => {
  it("sends tool summaries with responsePrefix", async () => {
    const abortController = new AbortController();
    replyMock.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(sendMock.mock.calls[0][1]).toBe("PFX tool update");
    expect(sendMock.mock.calls[1][1]).toBe("PFX final reply");
  });

  it("replies with pairing code when dmPolicy is pairing and no allowFrom is set", async () => {
    config = {
      ...config,
      signal: { autoStart: false, dmPolicy: "pairing", allowFrom: [] },
    };
    const abortController = new AbortController();

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      "Pairing code: PAIRCODE",
    );
  });

  it("does not resend pairing code when a request is already pending", async () => {
    config = {
      ...config,
      signal: { autoStart: false, dmPolicy: "pairing", allowFrom: [] },
    };
    const abortController = new AbortController();
    upsertPairingRequestMock
      .mockResolvedValueOnce({ code: "PAIRCODE", created: true })
      .mockResolvedValueOnce({ code: "PAIRCODE", created: false });

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Ada",
          timestamp: 1,
          dataMessage: {
            message: "hello",
          },
        },
      };
      await onEvent({
        event: "receive",
        data: JSON.stringify(payload),
      });
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          ...payload,
          envelope: { ...payload.envelope, timestamp: 2 },
        }),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    await flush();

    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects after stream errors until aborted", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    let calls = 0;

    streamMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("stream dropped");
      }
      abortController.abort();
    });

    try {
      const monitorPromise = monitorSignalProvider({
        autoStart: false,
        baseUrl: "http://127.0.0.1:8080",
        abortSignal: abortController.signal,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await monitorPromise;

      expect(streamMock).toHaveBeenCalledTimes(2);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
