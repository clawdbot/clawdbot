import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGatewayMock: vi.fn(),
  getScopedChannelsCommandSecretTargetsMock: vi.fn(),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    hoisted.resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set(["skills.entries.*.apiKey"]),
  getScopedChannelsCommandSecretTargets: (...args: unknown[]) =>
    hoisted.getScopedChannelsCommandSecretTargetsMock(...args),
}));

const { resolveQueuedReplyExecutionConfig, resolveQueuedReplyRuntimeConfig } =
  await import("./agent-runner-utils.js");
const { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
  await import("../../config/config.js");

describe("resolveQueuedReplyExecutionConfig channel scope", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockReset()
      .mockImplementation(async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }));
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReset().mockReturnValue({
      targetIds: new Set(["channels.discord.token"]),
      allowedPaths: new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    });
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("resolves base runtime targets, then active channel/account targets from originating context", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;
    const baseResolved = { baseResolved: true } as unknown as OpenClawConfig;
    const scopedResolved = { scopedResolved: true } as unknown as OpenClawConfig;
    hoisted.resolveCommandSecretRefsViaGatewayMock
      .mockResolvedValueOnce({
        resolvedConfig: baseResolved,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      })
      .mockResolvedValueOnce({
        resolvedConfig: scopedResolved,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      });

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig, {
      originatingChannel: "discord",
      messageProvider: "slack",
      originatingAccountId: "work",
      agentAccountId: "default",
    });

    expect(resolved).toBe(scopedResolved);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(2);
    const baseCall = hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0] as {
      config: OpenClawConfig;
      commandName: string;
      targetIds: Set<string>;
    };
    expect(baseCall.config).toBe(sourceConfig);
    expect(baseCall.commandName).toBe("reply");
    expect(baseCall.targetIds).toEqual(new Set(["skills.entries.*.apiKey"]));
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: baseResolved,
      channel: "discord",
      accountId: "work",
    });
    const scopedCall = hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[1]?.[0] as {
      config: OpenClawConfig;
      commandName: string;
      targetIds: Set<string>;
      allowedPaths?: Set<string>;
    };
    expect(scopedCall.config).toBe(baseResolved);
    expect(scopedCall.commandName).toBe("reply");
    expect(scopedCall.targetIds).toEqual(new Set(["channels.discord.token"]));
    expect(scopedCall.allowedPaths).toEqual(
      new Set(["channels.discord.token", "channels.discord.accounts.work.token"]),
    );
  });

  it("falls back to messageProvider and agentAccountId when originating values are missing", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
      agentAccountId: "ops",
    });

    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: sourceConfig,
      channel: "discord",
      accountId: "ops",
    });
  });

  it("skips scoped channel resolution when no active channel can be resolved", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;

    const resolved = await resolveQueuedReplyExecutionConfig(sourceConfig);

    expect(resolved).toBe(sourceConfig);
    expect(hoisted.resolveCommandSecretRefsViaGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).not.toHaveBeenCalled();
  });

  it("prefers the runtime snapshot as the base config for secret resolution", async () => {
    const sourceConfig = { source: true } as unknown as OpenClawConfig;
    const runtimeConfig = { runtime: true } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    hoisted.getScopedChannelsCommandSecretTargetsMock.mockReturnValue({
      targetIds: new Set<string>(),
    });

    await resolveQueuedReplyExecutionConfig(sourceConfig, {
      messageProvider: "discord",
    });

    const baseCall = hoisted.resolveCommandSecretRefsViaGatewayMock.mock.calls[0]?.[0] as {
      config: OpenClawConfig;
      commandName: string;
    };
    expect(baseCall.config).toBe(runtimeConfig);
    expect(baseCall.commandName).toBe("reply");
    expect(hoisted.getScopedChannelsCommandSecretTargetsMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      channel: "discord",
      accountId: undefined,
    });
  });

  it("does not replace an already resolved run config with a stale runtime snapshot", () => {
    const sourceConfig = {
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const staleRuntimeConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "stale-runtime-key",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const scopedResolvedConfig = {
      models: {
        providers: {
          openai: {
            apiKey: "fresh-scoped-key",
            models: [],
          },
        },
      },
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(staleRuntimeConfig, sourceConfig);

    expect(resolveQueuedReplyRuntimeConfig(structuredClone(sourceConfig))).toBe(staleRuntimeConfig);
    expect(resolveQueuedReplyRuntimeConfig(scopedResolvedConfig)).toBe(scopedResolvedConfig);
  });
});
