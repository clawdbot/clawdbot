import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../agents/fast-mode.js", () => ({
  resolveFastModeState: () => ({ enabled: false }),
}));

vi.mock("../../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel: () => "api-key",
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: () => [],
}));

vi.mock("../../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({
    updatedAt: Date.now(),
    providers: [],
  }),
  formatUsageWindowSummary: () => undefined,
}));

vi.mock("../group-activation.js", () => ({
  normalizeGroupActivation: (value: unknown) => value,
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    getFollowupQueueDepth: () => 0,
    resolveQueueSettings: () => ({ mode: "interrupt" }),
  };
});

const { buildStatusReply } = await import("./commands-status.js");

async function buildKiraStatusReply(cfg: OpenClawConfig) {
  return await buildStatusReply({
    cfg,
    command: {
      isAuthorizedSender: true,
      channel: "whatsapp",
    } as never,
    sessionKey: "agent:kira:main",
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  });
}

describe("buildStatusReply", () => {
  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        list: [
          {
            id: "kira",
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Think: xhigh");
  });

  it("shows per-agent fallback overrides in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: ["google/gemini-2.5-flash"],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: google/gemini-2.5-flash");
    expect(reply?.text).not.toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps default fallback config when the agent has no explicit model", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("Fallbacks: anthropic/claude-sonnet-4-6");
  });

  it("keeps agent primary strict when the agent has no explicit fallback override", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });

  it("treats an explicit empty per-agent fallback override as disabling inherited fallbacks", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
            fallbacks: ["anthropic/claude-sonnet-4-6"],
          },
        },
        list: [
          {
            id: "kira",
            model: {
              primary: "openai/gpt-5.4",
              fallbacks: [],
            },
          },
        ],
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).not.toContain("Fallbacks:");
  });
});
