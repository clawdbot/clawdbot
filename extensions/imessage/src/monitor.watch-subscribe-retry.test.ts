// Imessage tests cover monitor.watch subscribe retry plugin behavior.
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
import {
  installIMessageFailingStateRuntimeForTest,
  installIMessageStateRuntimeForTest,
} from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachIMessageMonitorAbortHandlerMock = vi.hoisted(() =>
  vi.fn<typeof attachIMessageMonitorAbortHandler>(() => () => {}),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachIMessageMonitorAbortHandlerMock,
}));

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

type MockIMessageRpcClient = IMessageRpcClient & {
  request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>;
  waitForClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createRpcClient(overrides?: {
  request?: (method: string) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}): MockIMessageRpcClient {
  const client = {
    request: vi.fn(
      overrides?.request ??
        (async () => {
          return { subscription: 1 };
        }),
    ),
    waitForClose: vi.fn(
      overrides?.waitForClose ??
        (async () => {
          return undefined;
        }),
    ),
    stop: vi.fn(async () => {}),
  };
  return client as unknown as MockIMessageRpcClient;
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installIMessageFailingStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    attachIMessageMonitorAbortHandlerMock.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.resetModules();
  });

  it("retries a transient watch.subscribe startup timeout without tearing down the monitor", async () => {
    const runtime = createRuntime();
    const firstClient = createRpcClient({
      request: async () => {
        throw new Error("imsg rpc timeout (watch.subscribe)");
      },
    });
    const secondClient = createRpcClient();

    createIMessageRpcClientMock
      .mockResolvedValueOnce(firstClient)
      .mockResolvedValueOnce(secondClient);

    const monitorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    });

    await vi.runAllTimersAsync();
    await monitorPromise;

    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(2);
    expect(firstClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.waitForClose).toHaveBeenCalledTimes(1);
    expect(secondClient.stop).toHaveBeenCalledTimes(1);
    expect(secondClient.request).toHaveBeenCalledWith(
      "watch.subscribe",
      { attachments: false, include_reactions: true },
      { timeoutMs: 10_000 },
    );
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const retryLog = String(runtime.log.mock.calls[0]?.[0]);
    expect(retryLog).toContain("imessage: watch.subscribe startup failed attempt=1/3");
    expect(retryLog).toContain("account=default");
    expect(retryLog).toContain("cliPath=imsg");
    expect(retryLog).toContain("dbPath=default");
    expect(retryLog).toContain("timeoutMs=10000");
    expect(retryLog).toContain("since_rowid=none");
    expect(retryLog).toContain("attachments=false");
    expect(retryLog).toContain("retry_in_ms=1000");
    expect(retryLog).toContain("Error: imsg rpc timeout (watch.subscribe)");
    expect(
      runtime.error.mock.calls.some(([message]) =>
        String(message).includes("imessage: monitor failed"),
      ),
    ).toBe(false);
  });

  it("still fails after bounded startup retries are exhausted", async () => {
    const runtime = createRuntime();
    createIMessageRpcClientMock.mockImplementation(async () =>
      createRpcClient({
        request: async () => {
          throw new Error("imsg rpc timeout (watch.subscribe)");
        },
      }),
    );

    const monitorErrorPromise = monitorIMessageProvider({
      config: { channels: { imessage: {} } } as never,
      runtime: runtime as never,
    }).catch((error: unknown) => error);

    await vi.runAllTimersAsync();
    const monitorError = await monitorErrorPromise;

    expect(monitorError).toBeInstanceOf(Error);
    expect((monitorError as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    expect(createIMessageRpcClientMock).toHaveBeenCalledTimes(3);
    expect(runtime.error).toHaveBeenCalledTimes(1);
    const failureLog = String(runtime.error.mock.calls[0]?.[0]);
    expect(failureLog).toContain(
      "imessage: monitor failed: imessage: watch.subscribe startup failed attempt=3/3",
    );
    expect(failureLog).toContain("account=default");
    expect(failureLog).toContain("timeoutMs=10000");
    expect(failureLog).toContain("Error: imsg rpc timeout (watch.subscribe)");
  });

  it("logs one redacted diagnostic for repeated from-me drops", async () => {
    vi.useRealTimers();
    installIMessageStateRuntimeForTest();
    const runtime = createRuntime();
    let onNotification:
      | ((message: { method: string; params: unknown }) => void | Promise<void>)
      | undefined;
    const runId = Date.now();
    const client = createRpcClient({
      waitForClose: async () => {
        for (const [id, guid] of [
          [43, `p:0/outbound-guid-${runId}`],
          [44, `p:0/second-outbound-guid-${runId}`],
        ] as const) {
          await onNotification?.({
            method: "message",
            params: {
              message: {
                id,
                chat_id: 456,
                guid,
                sender: "+15550001111",
                is_from_me: true,
                is_group: true,
                text: "private message text",
                created_at: new Date().toISOString(),
              },
            },
          });
        }
        await Promise.resolve();
        await Promise.resolve();
      },
    });
    createIMessageRpcClientMock.mockImplementation(async (params) => {
      onNotification = params?.onNotification;
      return client;
    });

    await monitorIMessageProvider({
      config: { channels: { imessage: { dmPolicy: "open", groupPolicy: "open" } } } as never,
      runtime: runtime as never,
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(runtime.error.mock.calls).toEqual([]);
    expect(runtime.log.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining('reason="from me"'),
    ]);
    const diagnostics = runtime.log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('reason="from me"'));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(
      'account=default reason="from me" chat_id=456 group=true message_id=43 guid=present',
    );
    expect(diagnostics[0]).not.toContain("outbound-guid");
    expect(diagnostics[0]).not.toContain("private message text");
    expect(diagnostics[0]).not.toContain("+15550001111");
  });
});
