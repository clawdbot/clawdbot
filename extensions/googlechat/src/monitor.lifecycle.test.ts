// Google Chat tests cover monitor lifecycle status publication.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ingressStart: vi.fn(),
  ingressStop: vi.fn(async () => undefined),
  registerTarget: vi.fn(() => vi.fn()),
  setProcessor: vi.fn(),
}));

vi.mock("./monitor-ingress.js", () => ({
  createGoogleChatIngressMonitor: () => ({
    receive: vi.fn(),
    start: mocks.ingressStart,
    stop: mocks.ingressStop,
  }),
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: mocks.registerTarget,
  setGoogleChatWebhookEventProcessor: mocks.setProcessor,
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: () => ({}),
}));

import { startGoogleChatMonitor } from "./monitor.js";

describe("Google Chat monitor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerTarget.mockReturnValue(vi.fn());
  });

  it("publishes ready after the webhook target is registered", async () => {
    const statusSink = vi.fn();

    const stop = await startGoogleChatMonitor({
      account: { accountId: "default", enabled: true, credentialSource: "config", config: {} },
      config: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      webhookPath: "/googlechat",
      statusSink,
    } as never);

    expect(mocks.registerTarget).toHaveBeenCalledOnce();
    expect(statusSink).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    await stop();
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    mocks.registerTarget.mockImplementationOnce(() => {
      throw new Error("Google Chat route conflict");
    });

    await expect(
      startGoogleChatMonitor({
        account: { accountId: "default", enabled: true, credentialSource: "config", config: {} },
        config: {},
        runtime: {},
        abortSignal: new AbortController().signal,
        webhookPath: "/googlechat",
        statusSink,
      } as never),
    ).rejects.toThrow("Google Chat route conflict");

    expect(mocks.ingressStart).toHaveBeenCalledOnce();
    expect(mocks.ingressStop).toHaveBeenCalledOnce();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });
});
