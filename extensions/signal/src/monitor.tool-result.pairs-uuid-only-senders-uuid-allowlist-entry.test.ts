import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
  config,
  getSignalToolResultTestMocks,
  installSignalToolResultTestHooks,
  setSignalToolResultTestConfig,
} from "./monitor.tool-result.test-harness.js";

installSignalToolResultTestHooks();
const { monitorSignalProvider } = await import("./monitor.js");

const { replyMock, sendMock, streamMock, signalRpcRequestMock, upsertPairingRequestMock } =
  getSignalToolResultTestMocks();

type MonitorSignalProviderOptions = Parameters<typeof monitorSignalProvider>[0];

async function runMonitorWithMocks(opts: MonitorSignalProviderOptions) {
  return monitorSignalProvider(opts);
}
describe("monitorSignalProvider tool results", () => {
  it("pairs uuid-only senders with a uuid allowlist entry", async () => {
    const baseChannels = (config.channels ?? {}) as Record<string, unknown>;
    const baseSignal = (baseChannels.signal ?? {}) as Record<string, unknown>;
    setSignalToolResultTestConfig({
      ...config,
      channels: {
        ...baseChannels,
        signal: {
          ...baseSignal,
          autoStart: false,
          dmPolicy: "pairing",
          allowFrom: [],
        },
      },
    });
    const abortController = new AbortController();
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    streamMock.mockImplementation(async ({ onEvent }) => {
      const payload = {
        envelope: {
          sourceUuid: uuid,
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

    await runMonitorWithMocks({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      abortSignal: abortController.signal,
    });

    expect(replyMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalledWith({
      channel: "signal",
      id: `uuid:${uuid}`,
      accountId: "default",
      meta: { name: "Ada" },
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]).toBe(`signal:${uuid}`);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain(
      `Your Signal sender id: uuid:${uuid}`,
    );
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
        reconnectPolicy: {
          initialMs: 1,
          maxMs: 1,
          factor: 1,
          jitter: 0,
        },
      });

      await vi.advanceTimersByTimeAsync(5);
      await monitorPromise;

      expect(streamMock).toHaveBeenCalledTimes(2);
      expect(streamMock.mock.calls[0]?.[0]?.timeoutMs).toBe(0);
      expect(streamMock.mock.calls[1]?.[0]?.timeoutMs).toBe(0);
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("sizes attachment RPC response caps from mediaMaxMb", async () => {
    const abortController = new AbortController();
    const maxBytes = 2 * 1024 * 1024;
    const expectedMaxResponseBytes = Math.ceil((maxBytes * 4) / 3) + 64 * 1024;

    replyMock.mockResolvedValue({ text: "ok" });
    signalRpcRequestMock.mockResolvedValue({ data: Buffer.from("hello").toString("base64") });
    streamMock.mockImplementation(async ({ onEvent }) => {
      await onEvent({
        event: "receive",
        data: JSON.stringify({
          envelope: {
            sourceNumber: "+15550001111",
            sourceName: "Ada",
            timestamp: 1,
            dataMessage: {
              message: "",
              attachments: [{ id: "attachment-1", size: 1_500_000, contentType: "text/plain" }],
            },
          },
        }),
      });
      abortController.abort();
    });

    await monitorSignalProvider({
      autoStart: false,
      baseUrl: "http://127.0.0.1:8080",
      mediaMaxMb: 2,
      abortSignal: abortController.signal,
    });

    expect(signalRpcRequestMock).toHaveBeenCalledWith(
      "getAttachment",
      {
        id: "attachment-1",
        recipient: "+15550001111",
      },
      {
        baseUrl: "http://127.0.0.1:8080",
        timeoutMs: undefined,
        apiMode: "auto",
        maxResponseBytes: expectedMaxResponseBytes,
      },
    );
  });
});
