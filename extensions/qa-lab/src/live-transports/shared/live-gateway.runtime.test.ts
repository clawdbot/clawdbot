import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaGatewayChild, startQaMockOpenAiServer } = vi.hoisted(() => ({
  startQaGatewayChild: vi.fn(),
  startQaMockOpenAiServer: vi.fn(),
}));

vi.mock("../../gateway-child.js", () => ({
  startQaGatewayChild,
}));

vi.mock("../../mock-openai-server.js", () => ({
  startQaMockOpenAiServer,
}));

import { startQaLiveLaneGateway } from "./live-gateway.runtime.js";

function createStubTransport(baseUrl = "http://127.0.0.1:43123") {
  return {
    requiredPluginIds: ["qa-channel"],
    createGatewayConfig: () => ({
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl,
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
          pollTimeoutMs: 250,
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
        },
      },
    }),
  };
}

describe("startQaLiveLaneGateway", () => {
  const gatewayStop = vi.fn();
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();

  beforeEach(() => {
    gatewayStop.mockReset();
    gatewayCall.mockReset();
    mockStop.mockReset();
    startQaGatewayChild.mockReset();
    startQaMockOpenAiServer.mockReset();

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall,
      cfg: {},
      stop: gatewayStop,
    });
    startQaMockOpenAiServer.mockResolvedValue({
      baseUrl: "http://127.0.0.1:44080",
      stop: mockStop,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("threads the mock provider base url into the gateway child", async () => {
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      controlUiEnabled: false,
    });

    expect(startQaMockOpenAiServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 0,
    });
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        transportBaseUrl: "http://127.0.0.1:43123",
        providerBaseUrl: "http://127.0.0.1:44080/v1",
        providerMode: "mock-openai",
      }),
    );

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("skips mock bootstrap for live frontier runs", async () => {
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.4",
      alternateModel: "openai/gpt-5.4",
      controlUiEnabled: false,
    });

    expect(startQaMockOpenAiServer).not.toHaveBeenCalled();
    expect(startQaGatewayChild).toHaveBeenCalledWith(
      expect.objectContaining({
        transportBaseUrl: "http://127.0.0.1:43123",
        providerBaseUrl: undefined,
        providerMode: "live-frontier",
      }),
    );

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
  });

  it("still stops the mock server when gateway shutdown fails", async () => {
    gatewayStop.mockRejectedValueOnce(new Error("gateway down"));
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources:\ngateway stop failed: gateway down",
    );
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("reports both gateway and mock shutdown failures together", async () => {
    gatewayStop.mockRejectedValueOnce(new Error("gateway down"));
    mockStop.mockRejectedValueOnce(new Error("mock down"));
    const harness = await startQaLiveLaneGateway({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.4",
      alternateModel: "mock-openai/gpt-5.4-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources:\ngateway stop failed: gateway down\nmock provider stop failed: mock down",
    );
  });
});
