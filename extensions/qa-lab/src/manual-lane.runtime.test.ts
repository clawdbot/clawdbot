import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaLabServer, startQaGatewayChild, startQaProviderServer } = vi.hoisted(() => ({
  startQaLabServer: vi.fn(),
  startQaGatewayChild: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("./lab-server.js", () => ({
  startQaLabServer,
}));

vi.mock("./gateway-child.js", () => ({
  startQaGatewayChild,
}));

vi.mock("./providers/server-runtime.js", () => ({
  startQaProviderServer,
}));

import { runQaManualLane } from "./manual-lane.runtime.js";

describe("runQaManualLane", () => {
  const gatewayStop = vi.fn();
  const mockStop = vi.fn();
  const labStop = vi.fn();

  beforeEach(() => {
    gatewayStop.mockReset();
    mockStop.mockReset();
    labStop.mockReset();
    startQaLabServer.mockReset();
    startQaGatewayChild.mockReset();
    startQaProviderServer.mockReset();

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
          messages: [
            {
              direction: "outbound",
              conversation: { id: "qa-operator" },
              text: "Protocol note: mock reply.",
            },
          ],
        }),
      },
      stop: labStop,
    });

    startQaGatewayChild.mockResolvedValue({
      call: vi
        .fn()
        .mockResolvedValueOnce({ runId: "run-1" })
        .mockResolvedValueOnce({ status: "ok" }),
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

    expect(startQaProviderServer).toHaveBeenCalledWith("mock-openai");
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot: "/tmp/openclaw-repo",
        providerMode: "mock-openai",
        providerBaseUrl: "http://127.0.0.1:44080/v1",
      }),
    );
    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      embeddedGateway: "disabled",
    });
    expect(result.reply).toBe("Protocol note: mock reply.");
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(labStop).toHaveBeenCalledTimes(1);
  });

  it("skips the mock provider bootstrap for live frontier runs", async () => {
    const result = await runQaManualLane({
      repoRoot: "/tmp/openclaw-repo",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.5",
      message: "check the kickoff file",
      timeoutMs: 5_000,
      replySettleMs: 0,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("live-frontier");
    expect(startQaLabServer).toHaveBeenCalledWith({
      repoRoot: "/tmp/openclaw-repo",
      embeddedGateway: "disabled",
    });
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMode: "live-frontier",
        providerBaseUrl: undefined,
      }),
    );
    expect(result.reply).toBe("Protocol note: mock reply.");
  });
});
