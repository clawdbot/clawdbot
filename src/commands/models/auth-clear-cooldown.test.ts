// Covers explicit clearing of locally stored auth-profile cooldown state.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  clearAuthProfileCooldown: vi.fn(async () => undefined),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  loadModelsConfig: vi.fn(),
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  clearAuthProfileCooldown: mocks.clearAuthProfileCooldown,
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
}));

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: mocks.refreshRunningGatewayAuthState,
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

const { modelsAuthClearCooldownCommand } = await import("./auth-clear-cooldown.js");

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

describe("models auth clear-cooldown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadModelsConfig.mockResolvedValue({} as OpenClawConfig);
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": { type: "oauth", provider: "openai", access: "token" },
      },
      usageStats: {
        "openai:default": { blockedUntil: Date.now() + 60_000 },
      },
    } satisfies AuthProfileStore);
  });

  it("clears stored state for the selected agent and refreshes the gateway", async () => {
    const runtime = createRuntime();

    await modelsAuthClearCooldownCommand(
      { profileId: "openai:default", agent: "planner" },
      runtime,
    );

    expect(mocks.clearAuthProfileCooldown).toHaveBeenCalledWith({
      store: expect.any(Object),
      profileId: "openai:default",
      agentDir: "/tmp/agent-planner",
    });
    expect(mocks.refreshRunningGatewayAuthState).toHaveBeenCalledOnce();
    expect(runtime.logs).toContain("Agent: planner");
    expect(runtime.logs).toContain(
      "Cleared stored cooldown and disable state for auth profile: openai:default",
    );
  });

  it("reports when no stored state exists without refreshing the gateway", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": { type: "oauth", provider: "openai", access: "token" },
      },
    } satisfies AuthProfileStore);
    const runtime = createRuntime();

    await modelsAuthClearCooldownCommand({ profileId: "openai:default" }, runtime);

    expect(mocks.clearAuthProfileCooldown).not.toHaveBeenCalled();
    expect(mocks.refreshRunningGatewayAuthState).not.toHaveBeenCalled();
    expect(runtime.logs).toContain(
      "No stored cooldown or disable state for auth profile: openai:default",
    );
  });

  it("requires a profile id", async () => {
    await expect(
      modelsAuthClearCooldownCommand({ profileId: "  " }, createRuntime()),
    ).rejects.toThrow("Missing profile id");
  });
});
