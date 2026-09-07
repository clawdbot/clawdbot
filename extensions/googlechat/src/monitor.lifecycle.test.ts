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

const configuredAccount = {
  accountId: "default",
  enabled: true,
  credentialSource: "config",
  config: {
    audienceType: "project-number",
    audience: "1234567890",
  },
};

describe("Google Chat monitor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerTarget.mockReturnValue(vi.fn());
  });

  it.each([
    { audienceType: "app-url", audience: "https://chat.example.test/googlechat" },
    { audienceType: "project-number", audience: "1234567890" },
  ])("publishes ready after the $audienceType webhook target is registered", async (config) => {
    const statusSink = vi.fn();

    const stop = await startGoogleChatMonitor({
      account: { ...configuredAccount, config },
      config: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      webhookPath: "/googlechat",
      statusSink,
    } as never);

    expect(mocks.registerTarget).toHaveBeenCalledOnce();
    expect(mocks.registerTarget).toHaveBeenCalledWith(expect.objectContaining(config));
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

  it.each([
    { description: "both audience settings are missing", config: {} },
    { description: "the audience is missing", config: { audienceType: "app-url" } },
    {
      description: "the audience is blank",
      config: { audienceType: "app-url", audience: "   " },
    },
    {
      description: "the audience type is missing",
      config: { audience: "https://chat.example.test/googlechat" },
    },
    {
      description: "the audience type is unsupported",
      config: {
        audienceType: "unsupported",
        audience: "https://chat.example.test/googlechat",
      },
    },
  ])("blocks startup when $description", async ({ config }) => {
    const statusSink = vi.fn();
    const runtime = { error: vi.fn() };

    const stop = await startGoogleChatMonitor({
      account: { ...configuredAccount, config },
      config: {},
      runtime,
      abortSignal: new AbortController().signal,
      webhookPath: "/googlechat",
      statusSink,
    } as never);

    expect(mocks.ingressStart).not.toHaveBeenCalled();
    expect(mocks.registerTarget).not.toHaveBeenCalled();
    expect(statusSink).toHaveBeenCalledWith({
      lifecycle: "blocked",
      terminalDisconnect: true,
      running: true,
      connected: false,
      webhookPath: undefined,
      lastError: expect.stringContaining("channels.googlechat.audienceType"),
    });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("channels.googlechat.audience"),
    );
    await expect(stop()).resolves.toBeUndefined();
    expect(mocks.ingressStop).not.toHaveBeenCalled();
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    mocks.registerTarget.mockImplementationOnce(() => {
      throw new Error("Google Chat route conflict");
    });

    await expect(
      startGoogleChatMonitor({
        account: configuredAccount,
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
