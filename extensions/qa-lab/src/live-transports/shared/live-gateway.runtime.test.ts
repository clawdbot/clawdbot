// Qa Lab tests cover live gateway plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startQaGatewayChild, startQaProviderServer, gatewayStop } = vi.hoisted(() => ({
  startQaGatewayChild: vi.fn(),
  gatewayStop: vi.fn(),
  startQaProviderServer: vi.fn(),
}));

vi.mock("../../gateway-child.js", () => ({
  createQaGatewayChild: () => ({
    start: (params: unknown) => startQaGatewayChild(params),
    stop: gatewayStop,
  }),
}));

vi.mock("../../providers/server-runtime.js", () => ({
  startQaProviderServer,
}));

import { createQaLiveLaneGateway } from "./live-gateway.runtime.js";

type GatewayOptions = {
  forcedRuntime?: string;
  providerBaseUrl?: string;
  providerMode?: string;
  transportBaseUrl?: string;
  mutateConfig?: (cfg: OpenClawConfig) => OpenClawConfig;
};

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

function firstGatewayOptions(): GatewayOptions | undefined {
  return startQaGatewayChild.mock.calls[0]?.[0] as GatewayOptions | undefined;
}

describe("createQaLiveLaneGateway", () => {
  const gatewayCall = vi.fn();
  const mockStop = vi.fn();
  const owners: ReturnType<typeof createQaLiveLaneGateway>[] = [];
  const ownGateway = () => {
    const owner = createQaLiveLaneGateway();
    owners.push(owner);
    return owner;
  };

  beforeEach(() => {
    gatewayStop.mockReset().mockResolvedValue({ process: "confirmed-stopped", errors: [] });
    gatewayCall.mockReset();
    mockStop.mockReset();
    startQaGatewayChild.mockReset();
    startQaProviderServer.mockReset();

    startQaGatewayChild.mockResolvedValue({
      call: gatewayCall,
      cfg: {},
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

  afterEach(async () => {
    for (const owner of owners.splice(0)) {
      await owner.stop();
    }
    vi.clearAllMocks();
  });

  it("exposes unconfirmed teardown even when startup never returns a ready handle", async () => {
    const startupError = new Error("gateway startup failed");
    const stopError = new Error("gateway group still alive");
    startQaGatewayChild.mockRejectedValueOnce(startupError);
    gatewayStop.mockResolvedValue({ process: "unconfirmed", errors: [stopError] });
    const owner = createQaLiveLaneGateway();
    await expect(
      owner.start({
        repoRoot: "/tmp/openclaw-repo",
        transport: createStubTransport(),
        transportBaseUrl: "http://127.0.0.1:43123",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
      }),
    ).rejects.toBe(startupError);
    await expect(owner.stop()).resolves.toEqual({ process: "unconfirmed", errors: [stopError] });
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("closes child admission while provider startup is pending", async () => {
    let release!: (mock: { baseUrl: string; stop: typeof mockStop }) => void;
    startQaProviderServer.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    gatewayStop.mockResolvedValue({ process: "never-spawned", errors: [] });
    const owner = createQaLiveLaneGateway();
    const startup = owner.start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
    });
    const rejection = expect(startup).rejects.toThrow("lifecycle is closed");
    const stopping = owner.stop();
    release({ baseUrl: "http://127.0.0.1:44080", stop: mockStop });
    await rejection;
    await expect(stopping).resolves.toEqual({ process: "never-spawned", errors: [] });
    expect(startQaGatewayChild).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledOnce();
  });

  it("threads the mock provider base url into the gateway child", async () => {
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.5",
      alternateModel: "mock-openai/gpt-5.5-alt",
      controlUiEnabled: false,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("mock-openai", {
      modelRefs: ["mock-openai/gpt-5.5", "mock-openai/gpt-5.5-alt"],
    });
    const gatewayOptions = firstGatewayOptions();
    expect(gatewayOptions?.transportBaseUrl).toBe("http://127.0.0.1:43123");
    expect(gatewayOptions?.providerBaseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(gatewayOptions?.providerMode).toBe("mock-openai");

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("forwards a scenario-selected agent runtime to the gateway child", async () => {
    await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.5",
      alternateModel: "openai/gpt-5.4",
      forcedRuntime: "codex",
    });

    expect(firstGatewayOptions()?.forcedRuntime).toBe("codex");
  });

  it("disables memory search for transport-only live lanes", async () => {
    await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });

    const { mutateConfig } = firstGatewayOptions() ?? {};
    if (!mutateConfig) {
      throw new Error("expected gateway config mutator");
    }
    const cfg = mutateConfig({
      plugins: {
        allow: ["acpx", "memory-core", "qa-channel"],
        entries: {
          acpx: { enabled: true },
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
        slots: {
          memory: "memory-core",
          contextEngine: "custom-context",
        },
      },
      memory: {
        search: {
          enabled: true,
        },
      },

      agents: {
        defaults: {},
      },
    });

    expect(cfg?.plugins?.allow).toEqual(["acpx", "qa-channel"]);
    expect(cfg?.plugins?.entries).not.toHaveProperty("memory-core");
    expect(cfg?.plugins?.slots?.memory).toBe("none");
    expect(cfg?.plugins?.slots?.contextEngine).toBe("custom-context");
    expect(cfg?.memory?.search?.enabled).toBe(false);
  });

  it("forwards gateway stop options to the child harness", async () => {
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });

    await harness.stop({ preserveToDir: ".artifacts/qa-e2e/debug" });
    expect(gatewayStop).toHaveBeenCalledWith({ preserveToDir: ".artifacts/qa-e2e/debug" });
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("skips mock bootstrap for live frontier runs", async () => {
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "live-frontier",
      primaryModel: "openai/gpt-5.6-luna",
      alternateModel: "openai/gpt-5.6-luna",
      controlUiEnabled: false,
    });

    expect(startQaProviderServer).toHaveBeenCalledWith("live-frontier", {
      modelRefs: ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"],
    });
    const gatewayOptions = firstGatewayOptions();
    expect(gatewayOptions?.transportBaseUrl).toBe("http://127.0.0.1:43123");
    expect(gatewayOptions?.providerBaseUrl).toBeUndefined();
    expect(gatewayOptions?.providerMode).toBe("live-frontier");

    await harness.stop();
    expect(gatewayStop).toHaveBeenCalledTimes(1);
  });

  it("finalizes failed startup with the caller's artifact policy", async () => {
    const owner = ownGateway();
    startQaGatewayChild.mockRejectedValueOnce(new Error("gateway failed"));

    await expect(
      owner.start({
        repoRoot: "/tmp/openclaw-repo",
        transport: createStubTransport(),
        transportBaseUrl: "http://127.0.0.1:43123",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        controlUiEnabled: false,
      }),
    ).rejects.toThrow("gateway failed");

    const options = { preserveToDir: ".artifacts/qa-e2e/debug" };
    await expect(owner.stop(options)).resolves.toEqual({
      process: "confirmed-stopped",
      errors: [],
    });
    expect(gatewayStop).toHaveBeenCalledWith(options);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("reports mock cleanup failures separately from the original startup failure", async () => {
    const owner = ownGateway();
    startQaGatewayChild.mockRejectedValueOnce(new Error("gateway failed"));
    mockStop.mockRejectedValueOnce(new Error("mock stuck"));

    await expect(
      owner.start({
        repoRoot: "/tmp/openclaw-repo",
        transport: createStubTransport(),
        transportBaseUrl: "http://127.0.0.1:43123",
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        controlUiEnabled: false,
      }),
    ).rejects.toThrow("gateway failed");
    await expect(owner.stop()).resolves.toMatchObject({
      process: "confirmed-stopped",
      errors: [expect.objectContaining({ message: "mock stuck" })],
    });

    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("still stops the mock server when gateway shutdown fails", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway down")],
    });
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources: gateway down",
    );
    expect(gatewayStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  it("reports both gateway and mock shutdown failures together", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway down")],
    });
    mockStop.mockRejectedValueOnce(new Error("mock down"));
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow(
      "failed to stop QA live lane resources: gateway down; mock down",
    );
  });

  it("retries only mock cleanup after gateway preservation succeeds", async () => {
    mockStop.mockRejectedValueOnce(new Error("mock down"));
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });
    const stopOptions = { preserveToDir: ".artifacts/qa-e2e/debug" };

    await expect(harness.stop(stopOptions)).rejects.toThrow("mock down");
    await expect(harness.stop(stopOptions)).resolves.toBeUndefined();

    expect(startQaGatewayChild).toHaveBeenCalledOnce();
    expect(gatewayStop).toHaveBeenCalledWith(stopOptions);
    expect(mockStop).toHaveBeenCalledTimes(2);
  });

  it("retries only gateway cleanup after mock shutdown succeeds", async () => {
    gatewayStop.mockResolvedValueOnce({
      process: "unconfirmed",
      errors: [new Error("gateway down")],
    });
    const harness = await ownGateway().start({
      repoRoot: "/tmp/openclaw-repo",
      transport: createStubTransport(),
      transportBaseUrl: "http://127.0.0.1:43123",
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      controlUiEnabled: false,
    });

    await expect(harness.stop()).rejects.toThrow("gateway down");
    await expect(harness.stop()).resolves.toBeUndefined();

    expect(gatewayStop).toHaveBeenCalledTimes(2);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});
