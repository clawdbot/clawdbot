// Covers `models auth order set/clear`: store writes and running-gateway refresh.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  setAuthProfileOrder: vi.fn(),
  loadModelsConfig: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  setAuthProfileOrder: mocks.setAuthProfileOrder,
  externalCliDiscoveryForProviderAuth: () => undefined,
  resolveAuthStatePathForDisplay: (agentDir: string) => `${agentDir}/auth-profiles.json`,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: mocks.loadModelsConfig,
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: (_cfg: OpenClawConfig, rawAgentId?: string) => ({
      agentId: rawAgentId ?? "main",
      agentDir: `/tmp/agent-${rawAgentId ?? "main"}`,
    }),
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
}));

const { modelsAuthOrderClearCommand, modelsAuthOrderSetCommand } = await import("./auth-order.js");

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => {
      logs.push(message);
    },
    error: () => {},
  } as unknown as RuntimeEnv & { logs: string[] };
}

function storeWith(profileIds: string[], order?: string[]): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((profileId) => [
        profileId,
        { type: "oauth" as const, provider: profileId.split(":")[0] ?? "anthropic", access: "tok" },
      ]),
    ),
    ...(order ? { order: { anthropic: order } } : {}),
  } as unknown as AuthProfileStore;
}

describe("models auth order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStore.mockReturnValue(
      storeWith(["anthropic:a", "anthropic:b"], ["anthropic:a"]),
    );
    mocks.setAuthProfileOrder.mockResolvedValue(
      storeWith(["anthropic:a", "anthropic:b"], ["anthropic:b", "anthropic:a"]),
    );
  });

  it("set writes the store order and refreshes a running gateway", async () => {
    const runtime = createRuntime();
    await modelsAuthOrderSetCommand(
      { provider: "anthropic", agent: "ops", order: ["anthropic:b", "anthropic:a"] },
      runtime,
    );

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-ops",
      provider: "anthropic",
      order: ["anthropic:b", "anthropic:a"],
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("ops");
    expect(runtime.logs).toContain("Auth profile order override: anthropic:b, anthropic:a");
  });

  it("accepts alias-provider profiles and reports the canonical stored order", async () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "xai:a": { type: "oauth", provider: "xai", access: "tok" },
      },
    });
    mocks.setAuthProfileOrder.mockResolvedValue({
      version: 1,
      profiles: {},
      order: { xai: ["xai:a"] },
    });
    const runtime = createRuntime();

    await modelsAuthOrderSetCommand({ provider: "x-ai", order: ["xai:a"] }, runtime);

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-main",
      provider: "xai",
      order: ["xai:a"],
    });
    expect(runtime.logs).toContain("Auth profile order override: xai:a");
  });

  it("clear removes the store order and refreshes a running gateway", async () => {
    const runtime = createRuntime();
    await modelsAuthOrderClearCommand({ provider: "anthropic" }, runtime);

    expect(mocks.setAuthProfileOrder).toHaveBeenCalledWith({
      agentDir: "/tmp/agent-main",
      provider: "anthropic",
      order: null,
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledWith("main");
    expect(runtime.logs.some((line) => line.includes("Auth profile order override cleared"))).toBe(
      true,
    );
  });

  it("does not refresh the gateway when the store update fails", async () => {
    mocks.setAuthProfileOrder.mockResolvedValue(null);

    await expect(
      modelsAuthOrderSetCommand({ provider: "anthropic", order: ["anthropic:a"] }, createRuntime()),
    ).rejects.toThrow("Failed to update auth state");
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
  });
});
