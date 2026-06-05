// Model list probe tests cover runtime probing while listing configured models.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, describe, expect, it, vi } from "vitest";

let probeModule: typeof import("./list.probe.js");

describe("mapFailoverReasonToProbeStatus", () => {
  beforeAll(async () => {
    vi.doMock("../../agents/embedded-agent.js", () => {
      throw new Error("embedded-agent should stay lazy for probe imports");
    });
    try {
      probeModule = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
    }
  });

  it("does not import the embedded runner on module load", () => {
    expect(probeModule.mapFailoverReasonToProbeStatus).toBeTypeOf("function");
  });

  it("maps failover reasons to probe statuses", () => {
    const { mapFailoverReasonToProbeStatus } = probeModule;
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("format");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");

    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("something_else")).toBe("unknown");
  });
});

describe("runAuthProbes", () => {
  it("runs Codex auth probes through raw OpenClaw model-run mode", async () => {
    const runEmbeddedAgent = vi.fn(async () => ({ text: "OK" }));
    vi.doMock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
    vi.doMock("../../agents/auth-profiles.js", () => ({
      externalCliDiscoveryScoped: () => undefined,
      ensureAuthProfileStore: () => ({
        version: 1,
        profiles: {
          "openai:profile": {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
          },
        },
        order: {},
      }),
      listProfilesForProvider: () => ["openai:profile"],
      resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
      resolveAuthProfileEligibility: () => ({ eligible: true }),
      resolveAuthProfileOrder: () => ["openai:profile"],
    }));
    vi.doMock("../../agents/model-auth.js", () => ({
      hasUsableCustomProviderApiKey: () => false,
      resolveEnvApiKey: () => null,
    }));
    vi.doMock("../../agents/model-catalog.js", () => ({
      loadModelCatalog: async () => [{ provider: "openai", id: "gpt-5.5" }],
    }));
    try {
      const module = await importFreshModule<typeof import("./list.probe.js")>(
        import.meta.url,
        `./list.probe.js?scope=${Math.random().toString(36).slice(2)}`,
      );
      const result = await module.runAuthProbes({
        cfg: {} as never,
        agentId: "probe-agent",
        agentDir: "/tmp/openclaw-probe-agent",
        workspaceDir: "/tmp/openclaw-probe-workspace",
        providers: ["openai"],
        modelCandidates: ["openai/gpt-5.5"],
        options: {
          provider: "openai",
          profileIds: ["openai:profile"],
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 8,
        },
      });

      expect(result.results[0]?.status).toBe("ok");
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRun: true,
          disableTools: true,
          authProfileId: "openai:profile",
          authProfileIdSource: "user",
        }),
      );
    } finally {
      vi.doUnmock("../../agents/embedded-agent.js");
      vi.doUnmock("../../agents/auth-profiles.js");
      vi.doUnmock("../../agents/model-auth.js");
      vi.doUnmock("../../agents/model-catalog.js");
    }
  });
});
