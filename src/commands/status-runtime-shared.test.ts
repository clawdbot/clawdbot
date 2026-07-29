// Status runtime shared tests cover gateway health, runtime details, and safe status probe fallbacks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveStatusGatewayHealth,
  resolveStatusGatewayHealthSafe,
  resolveStatusRuntimeSnapshot,
  resolveStatusSecurityAudit,
  resolveStatusServiceSummaries,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";

const mocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn(),
  runSecurityAudit: vi.fn(),
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
  resolveModelAuthLabel: vi.fn(),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: mocks.resolveReadOnlyChannelPluginsForConfig,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: mocks.resolveModelAuthLabel,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

function requireProviderUsageCall(): {
  timeoutMs?: number;
  config?: unknown;
  agentDir?: string;
  providers?: string[];
  auth?: Array<Record<string, unknown>>;
} {
  const call = mocks.loadProviderUsageSummary.mock.calls[0];
  if (!call) {
    throw new Error("expected provider usage summary call");
  }
  const params = call.at(0);
  if (!params || typeof params !== "object") {
    throw new Error("expected provider usage summary params");
  }
  return params as {
    timeoutMs?: number;
    config?: unknown;
    agentDir?: string;
    providers?: string[];
    auth?: Array<Record<string, unknown>>;
  };
}

describe("status-runtime-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.runSecurityAudit.mockResolvedValue({ summary: { critical: 0 }, findings: [] });
    mocks.callGateway.mockResolvedValue({ ok: true });
    mocks.getDaemonStatusSummary.mockResolvedValue({ label: "LaunchAgent" });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ label: "node" });
    mocks.resolveModelAuthLabel.mockReturnValue(undefined);
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [{ id: "telegram" }],
      configuredChannelIds: ["telegram"],
      missingConfiguredChannelIds: [],
    });
  });

  it("resolves the shared security audit payload", async () => {
    await resolveStatusSecurityAudit({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
    });

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
      plugins: [{ id: "telegram" }],
    });
    expect(mocks.resolveReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      { gateway: {} },
      {
        activationSourceConfig: { gateway: {} },
        includeSetupFallbackPlugins: false,
      },
    );
  });

  it("lets the security audit load configured channel plugins when read-only discovery is incomplete", async () => {
    mocks.resolveReadOnlyChannelPluginsForConfig.mockReturnValue({
      plugins: [],
      configuredChannelIds: ["external"],
      missingConfiguredChannelIds: ["external"],
    });

    await resolveStatusSecurityAudit({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
    });

    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: {} },
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });
  });

  it("resolves usage summaries with the provided timeout", async () => {
    await resolveStatusUsageSummary({
      timeoutMs: 1234,
      config: { gateway: {} },
    });

    const usageCall = requireProviderUsageCall();
    expect(usageCall.timeoutMs).toBe(1234);
    expect(usageCall.config).toEqual({ gateway: {} });
    expect(usageCall.agentDir).toContain("main");
  });

  it("adds Codex synthetic usage for configured OpenAI Codex runtime routes without profiles", async () => {
    mocks.loadProviderUsageSummary
      .mockResolvedValueOnce({
        updatedAt: 1,
        providers: [
          {
            provider: "anthropic",
            displayName: "Claude",
            windows: [],
            error: "HTTP 429",
          },
        ],
      })
      .mockResolvedValueOnce({
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 9 }],
          },
        ],
      });

    await expect(
      resolveStatusUsageSummary({
        timeoutMs: 3456,
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
        agentDir: "/tmp/status-agent",
      }),
    ).resolves.toEqual({
      updatedAt: 1,
      providers: [
        {
          provider: "anthropic",
          displayName: "Claude",
          windows: [],
          error: "HTTP 429",
        },
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenNthCalledWith(2, {
      timeoutMs: 3456,
      providers: ["openai"],
      auth: [
        {
          provider: "openai",
          token: "codex-app-server",
          hookProvider: "codex",
        },
      ],
      config: expect.any(Object),
      agentDir: "/tmp/status-agent",
    });
  });

  it("keeps existing OpenAI usage when Codex synthetic usage has no windows", async () => {
    mocks.loadProviderUsageSummary
      .mockResolvedValueOnce({
        updatedAt: 1,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [{ label: "5h", usedPercent: 22 }],
          },
        ],
      })
      .mockResolvedValueOnce({
        updatedAt: 2,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [],
          },
        ],
      });

    await expect(
      resolveStatusUsageSummary({
        timeoutMs: 3456,
        config: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        },
        agentDir: "/tmp/status-agent",
      }),
    ).resolves.toEqual({
      updatedAt: 1,
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 22 }],
        },
      ],
    });
  });

  it("does not add Codex synthetic usage for OpenAI routes pinned to OpenClaw runtime", async () => {
    await resolveStatusUsageSummary({
      timeoutMs: 3456,
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(requireProviderUsageCall()).not.toHaveProperty("auth");
  });

  it("does not add Codex synthetic usage for API-key-backed OpenAI Codex runtime routes", async () => {
    mocks.resolveModelAuthLabel.mockReturnValue("api-key (openai:api)");

    await resolveStatusUsageSummary({
      timeoutMs: 3456,
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.5" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
            },
          },
        },
      },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledOnce();
    expect(requireProviderUsageCall()).not.toHaveProperty("auth");
    expect(mocks.resolveModelAuthLabel).toHaveBeenCalledWith({
      provider: "openai",
      acceptedProviderIds: ["openai"],
      cfg: expect.any(Object),
      agentDir: "/tmp/status-agent",
      includeExternalProfiles: false,
    });
  });

  it("resolves usage summaries with explicit agent scope", async () => {
    await resolveStatusUsageSummary({
      timeoutMs: 2345,
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
    });

    expect(mocks.loadProviderUsageSummary).toHaveBeenCalledWith({
      timeoutMs: 2345,
      config: { gateway: {} },
      agentDir: "/tmp/status-agent",
    });
  });

  it("resolves gateway health with the shared probe call shape", async () => {
    await resolveStatusGatewayHealth({
      config: { gateway: {} },
      timeoutMs: 5000,
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 5000,
      config: { gateway: {} },
    });
  });

  it("returns a fallback health error when the gateway is unreachable", async () => {
    await expect(
      resolveStatusGatewayHealthSafe({
        config: { gateway: {} },
        gatewayReachable: false,
        gatewayProbeError: "timeout",
      }),
    ).resolves.toEqual({ error: "timeout" });
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("passes gateway call overrides through the safe health path", async () => {
    await resolveStatusGatewayHealthSafe({
      config: { gateway: {} },
      timeoutMs: 4321,
      gatewayReachable: true,
      callOverrides: {
        url: "ws://127.0.0.1:18789",
        token: "tok",
      },
    });

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      params: { probe: true },
      timeoutMs: 4321,
      config: { gateway: {} },
      url: "ws://127.0.0.1:18789",
      token: "tok",
    });
  });

  it("resolves daemon summaries together", async () => {
    await expect(resolveStatusServiceSummaries()).resolves.toEqual([
      { label: "LaunchAgent" },
      { label: "node" },
    ]);
  });

  it("resolves the shared runtime snapshot with security audit and runtime details", async () => {
    await expect(
      resolveStatusRuntimeSnapshot({
        config: { gateway: {} },
        sourceConfig: { gateway: { mode: "local" } },
        timeoutMs: 1234,
        usage: true,
        deep: true,
        gatewayReachable: true,
        includeSecurityAudit: true,
      }),
    ).resolves.toEqual({
      securityAudit: { summary: { critical: 0 }, findings: [] },
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { ok: true },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
    expect(mocks.runSecurityAudit).toHaveBeenCalledWith({
      config: { gateway: {} },
      sourceConfig: { gateway: { mode: "local" } },
      deep: false,
      deepTimeoutMs: 1234,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
      plugins: [{ id: "telegram" }],
    });
  });
});
