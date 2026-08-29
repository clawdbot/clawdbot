// Qa Lab tests cover manual lane plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  cleanupTransportAfterGatewayStop,
  cleanupTransportBeforeGatewayStop,
  createQaTransportAdapter,
  startQaGatewayChild,
  gatewayStop,
  startQaLabServer,
  startQaProviderServer,
} = vi.hoisted(() => ({
  cleanupTransportAfterGatewayStop: vi.fn(),
  cleanupTransportBeforeGatewayStop: vi.fn(),
  createQaTransportAdapter: vi.fn(),
  startQaLabServer: vi.fn(),
  startQaGatewayChild: vi.fn(),
  gatewayStop: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => startQaGatewayChild(params),
    stop: gatewayStop,
  }),
}));

vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer,
}));

vi.mock("./qa-transport-registry.js", () => ({
  createQaTransportAdapter,
}));

import { runQaManualLane } from "./manual-lane.runtime.js";

describe("runQaManualLane", () => {
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();
  const labStop = vi.fn();
  let outboundReply: string | null;

  beforeEach(() => {
    outboundReply = "Protocol note: mock reply.";
    gatewayCall.mockReset();
    gatewayStop.mockReset().mockResolvedValue({ process: "confirmed-stopped", errors: [] });
    mockStop.mockReset();
    labStop.mockReset();
    cleanupTransportAfterGatewayStop.mockReset();
    cleanupTransportBeforeGatewayStop.mockReset();
    cleanupTransportAfterGatewayStop.mockResolvedValue(undefined);
    cleanupTransportBeforeGatewayStop.mockResolvedValue(undefined);
    createQaTransportAdapter.mockReset();
    startQaLabServer.mockReset();
    startQaGatewayChild.mockReset();
    startQaProviderServer.mockReset();

    createQaTransportAdapter.mockResolvedValue({
      adapter: {
        buildAgentDelivery: () => ({
          channel: "qa-channel",
          to: "dm:qa-operator",
        }),
      },
      cleanupBeforeGatewayStop: cleanupTransportBeforeGatewayStop,
      cleanupAfterGatewayStop: cleanupTransportAfterGatewayStop,
    });

    startQaLabServer.mockResolvedValue({
      listenUrl: "http://127.0.0.1:43124",
      baseUrl: "http://127.0.0.1:58000",
      state: {
        reset: vi.fn(),
        addInboundMessage: vi.fn(),
        addOutboundMessage: vi.fn(),
        readMessage: vi.fn(),
        searchMessages: vi.fn(() => []),
        waitFor: vi.fn(),
        getSnapshot: () => ({
          messages:
            outboundReply === null
              ? []
              : [
                  {
                    direction: "outbound",
                    conversation: { id: "qa-operator" },
                    text: outboundReply,
                  },
                ],
        }),
      },
      stop: labStop,
    });

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall.mockResolvedValueOnce({ runId: "run-1" }).mockResolvedValueOnce({
        status: "ok",
      }),
      stop: gatewayStop,
    });

    startQaProviderServer.mockImplementation(async (providerMode: string) =>
      providerMode === "mock-openai"
        ? {
            baseUrl: "http://127.0.0.1:44080",
            stop: mockStop,
          }
        : null,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts the mock provider and threads its base url into the gateway child", async () => {
    const result = await runQaManualLane({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      message: "check the kickoff file",
      timeoutMs: 5_000,
      replySettleMs: 0,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("mock-openai", {
      modelRefs: ["mock-openai/gpt-5.5", "mock-openai/gpt-5.5-alt"],
    });
    const [gatewayOptions] = startQaGatewayChild.mock.calls[0] ?? [];
    expect(gatewayOptions?.repoRoot).toBe("/tmp/openclaw-repo");
    expect(gatewayOptions?.providerMode).toBe("mock-openai");
    expect(gatewayOptions?.providerBaseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      embeddedGateway: "disabled",
    });
    expect(result.reply).toBe("Protocol note: mock reply.");
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(cleanupTransportBeforeGatewayStop).toHaveBeenCalledTimes(1);
    expect(cleanupTransportAfterGatewayStop).toHaveBeenCalledTimes(1);
    expect(cleanupTransportBeforeGatewayStop.mock.invocationCallOrder[0]).toBeLessThan(
      gatewayStop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(gatewayStop.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupTransportAfterGatewayStop.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(labStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "timed-out run despite a stale reply",
      waited: { status: "timeout", error: "provider stalled" },
      reply: "stale assistant reply",
      error: "provider stalled",
    },
    {
      label: "failed run despite a stale reply",
      waited: { status: "error", error: "authentication failed" },
      reply: "stale assistant reply",
      error: "authentication failed",
    },
    {
      label: "successful run without an outbound reply",
      waited: { status: "ok" },
      reply: null,
      error: "manual lane did not produce a successful reply",
    },
    {
      label: "successful run with a whitespace-only reply",
      waited: { status: "ok" },
      reply: "   ",
      error: "manual lane did not produce a successful reply",
    },
    {
      label: "legacy completed run without an outbound reply",
      waited: { status: "error", error: "completed" },
      reply: null,
      error: "manual lane did not produce a successful reply",
    },
    {
      label: "legacy completed run with a whitespace-only reply",
      waited: { status: "error", error: " completed " },
      reply: "   ",
      error: "manual lane did not produce a successful reply",
    },
    {
      label: "timed-out run without an outbound reply",
      waited: { status: "timeout", error: "provider stalled" },
      reply: null,
      error: "manual lane did not produce a successful reply",
    },
    {
      label: "failed run with a whitespace-only reply",
      waited: { status: "error", error: "authentication failed" },
      reply: "   ",
      error: "manual lane did not produce a successful reply",
    },
  ])("rejects a $label after resource cleanup", async ({ waited, reply, error }) => {
    outboundReply = reply;
    gatewayCall.mockReset().mockResolvedValueOnce({ runId: "run-1" }).mockResolvedValueOnce(waited);

    await expect(
      runQaManualLane({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        message: "check the kickoff file",
        replySettleMs: 0,
      }),
    ).rejects.toThrow(error);

    expect(gatewayStop).toHaveBeenCalledOnce();
    expect(cleanupTransportBeforeGatewayStop).toHaveBeenCalledOnce();
    expect(cleanupTransportAfterGatewayStop).toHaveBeenCalledOnce();
    expect(mockStop).toHaveBeenCalledOnce();
    expect(labStop).toHaveBeenCalledOnce();
  });

  it.each([
    { status: "ok" },
    { status: "completed" },
    { status: "succeeded" },
    { status: "error", error: " completed " },
  ])("accepts the canonical successful agent wait result %#", async (waited) => {
    gatewayCall.mockReset().mockResolvedValueOnce({ runId: "run-1" }).mockResolvedValueOnce(waited);

    await expect(
      runQaManualLane({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        message: "check the kickoff file",
        replySettleMs: 0,
      }),
    ).resolves.toMatchObject({ waited, reply: "Protocol note: mock reply." });
  });

  it("skips the mock provider bootstrap for live frontier runs", async () => {
    const result = await runQaManualLane({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      message: "check the kickoff file",
      timeoutMs: 5_000,
      replySettleMs: 0,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("live-frontier", {
      modelRefs: ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"],
    });
    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      embeddedGateway: "disabled",
    });
    const [gatewayOptions] = startQaGatewayChild.mock.calls[0] ?? [];
    expect(gatewayOptions?.providerMode).toBe("live-frontier");
    expect(gatewayOptions?.providerBaseUrl).toBeUndefined();
    expect(result.reply).toBe("Protocol note: mock reply.");
  });

  it.each([
    { process: "never-spawned", diagnostic: false },
    { process: "confirmed-stopped", diagnostic: true },
    { process: "unconfirmed", diagnostic: true },
  ] as const)(
    "retains startup failure and gates after-stop cleanup for $process",
    async ({ process, diagnostic }) => {
      const startupError = new Error("gateway startup failed");
      const cleanupError = new Error("gateway cleanup diagnostic");
      startQaGatewayChild.mockRejectedValueOnce(startupError);
      gatewayStop.mockResolvedValue({ process, errors: diagnostic ? [cleanupError] : [] });
      const failure = await runQaManualLane({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        message: "check the kickoff file",
        replySettleMs: 0,
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ cause: startupError });
      if (diagnostic) {
        expect(failure).toMatchObject({
          errors: [startupError, expect.objectContaining({ errors: [cleanupError] })],
        });
      }
      expect(cleanupTransportAfterGatewayStop).toHaveBeenCalledTimes(
        process === "unconfirmed" ? 0 : 1,
      );
      expect(mockStop).toHaveBeenCalledOnce();
      expect(labStop).toHaveBeenCalledOnce();
    },
  );

  it("continues provider and lab teardown when gateway stop fails", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway stop failed")],
    });

    await expect(
      runQaManualLane({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        message: "check the kickoff file",
        timeoutMs: 5_000,
        replySettleMs: 0,
      }),
    ).rejects.toThrow("gateway stop failed");

    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(cleanupTransportBeforeGatewayStop).toHaveBeenCalledTimes(1);
    expect(cleanupTransportAfterGatewayStop).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(labStop).toHaveBeenCalledTimes(1);
  });

  it("caps the gateway client timeout for oversized manual waits", async () => {
    const result = await runQaManualLane({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      message: "check the kickoff file",
      timeoutMs: 9e15,
      replySettleMs: 0,
    });

    expect(result.waited).toEqual({ status: "ok" });
    expect(gatewayCall).toHaveBeenLastCalledWith(
      "agent.wait",
      {
        runId: "run-1",
        timeoutMs: 9e15,
      },
      { timeoutMs: MAX_TIMER_TIMEOUT_MS },
    );
  });
});
