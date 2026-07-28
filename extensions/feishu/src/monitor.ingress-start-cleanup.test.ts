// Feishu tests cover monitor ingress startup cleanup behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const ingressStartMock = vi.hoisted(() => vi.fn());
const ingressStopMock = vi.hoisted(() => vi.fn());
const threadBindingStopMock = vi.hoisted(() => vi.fn());
const monitorWebhookMock = vi.hoisted(() => vi.fn());
const monitorWebSocketMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createEventDispatcher: () => ({
    invoke: vi.fn(),
    register: vi.fn(),
  }),
}));

vi.mock("./dedup.js", () => ({
  hasProcessedFeishuMessage: vi.fn().mockResolvedValue(false),
  warmupDedupFromPluginState: vi.fn().mockResolvedValue(0),
}));

vi.mock("./feishu-ingress.js", () => ({
  createFeishuDurableIngress: () => ({
    invoke: vi.fn(),
    resolveLifecycle: vi.fn(),
    setSocketTerminator: vi.fn(),
    start: ingressStartMock,
    stop: ingressStopMock,
    waitForIdle: vi.fn(),
  }),
}));

vi.mock("./monitor.transport.js", () => ({
  monitorWebhook: monitorWebhookMock,
  monitorWebSocket: monitorWebSocketMock,
}));

vi.mock("./runtime.js", async () => {
  const { createFeishuRuntimeMockModule } = await import("./monitor.test-mocks.js");
  return createFeishuRuntimeMockModule();
});

vi.mock("./thread-bindings.js", () => ({
  createFeishuThreadBindingManager: () => ({ stop: threadBindingStopMock }),
}));

const { monitorSingleAccount } = await import("./monitor.account.js");

beforeEach(() => {
  ingressStartMock.mockReset();
  ingressStopMock.mockReset().mockResolvedValue(undefined);
  threadBindingStopMock.mockReset();
  monitorWebhookMock.mockReset();
  monitorWebSocketMock.mockReset();
});

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./dedup.js");
  vi.doUnmock("./feishu-ingress.js");
  vi.doUnmock("./monitor.transport.js");
  vi.doUnmock("./runtime.js");
  vi.doUnmock("./thread-bindings.js");
  vi.resetModules();
});

describe("Feishu ingress startup cleanup", () => {
  it("stops ingress before releasing account lifecycle state when start throws", async () => {
    const startError = new Error("durable ingress unavailable");
    ingressStartMock.mockImplementation(() => {
      throw startError;
    });

    await expect(
      monitorSingleAccount({
        cfg: { channels: { feishu: {} } } as never,
        account: {
          accountId: "default",
          config: { connectionMode: "websocket" },
        } as never,
        botOpenIdSource: {
          kind: "prefetched",
          botOpenId: "ou_bot",
          botName: "Bot",
          source: "provider",
        },
      }),
    ).rejects.toBe(startError);

    expect(ingressStopMock).toHaveBeenCalledTimes(1);
    expect(threadBindingStopMock).toHaveBeenCalledTimes(1);
    expect(monitorWebhookMock).not.toHaveBeenCalled();
    expect(monitorWebSocketMock).not.toHaveBeenCalled();
  });
});
