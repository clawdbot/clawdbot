// Verifies exact-profile usage reads stay bound to the trusted active agent scope.
import { beforeEach, describe, expect, it, vi } from "vitest";

const readProviderUsageProfileMock = vi.fn();
const getPluginRuntimeGatewayRequestScopeMock = vi.fn();
const getRuntimeConfigMock = vi.fn();
const resolveAgentDirMock = vi.fn();

vi.mock("../../infra/provider-usage.profile.js", () => ({
  readProviderUsageProfile: (...args: unknown[]) => readProviderUsageProfileMock(...args),
}));

vi.mock("./gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => getPluginRuntimeGatewayRequestScopeMock(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => getRuntimeConfigMock(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentDir: (...args: unknown[]) => resolveAgentDirMock(...args),
}));

import { readProviderUsageProfileForRuntime } from "./runtime-provider-usage.runtime.js";

const request = {
  providerId: "openai",
  authProfileId: "openai:default",
  includeIdentity: false as const,
  refreshCredentials: false as const,
};

describe("readProviderUsageProfileForRuntime", () => {
  beforeEach(() => {
    readProviderUsageProfileMock.mockReset();
    getPluginRuntimeGatewayRequestScopeMock.mockReset();
    getRuntimeConfigMock.mockReset();
    resolveAgentDirMock.mockReset();
    getRuntimeConfigMock.mockReturnValue({ agents: { entries: { work: {} } } });
    resolveAgentDirMock.mockReturnValue("/agents/work");
    readProviderUsageProfileMock.mockResolvedValue({
      provider: "openai",
      authProfileId: "openai:default",
      capturedAt: 1,
      displayName: "OpenAI",
      windows: [],
    });
  });

  it("fails closed outside a trusted active-agent scope", async () => {
    getPluginRuntimeGatewayRequestScopeMock.mockReturnValue({ pluginId: "quota-plugin" });

    await expect(readProviderUsageProfileForRuntime(request)).rejects.toThrow(/active agent/i);
    expect(readProviderUsageProfileMock).not.toHaveBeenCalled();
  });

  it("resolves the agent directory from the trusted active-agent scope", async () => {
    const config = { agents: { entries: { work: {} } } };
    getPluginRuntimeGatewayRequestScopeMock.mockReturnValue({
      pluginId: "quota-plugin",
      agentId: "work",
    });
    getRuntimeConfigMock.mockReturnValue(config);

    await readProviderUsageProfileForRuntime(request);

    expect(resolveAgentDirMock).toHaveBeenCalledWith(config, "work");
    expect(readProviderUsageProfileMock).toHaveBeenCalledWith(request, {
      config,
      agentDir: "/agents/work",
    });
  });
});
