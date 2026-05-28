import "./isolated-agent.mocks.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { BASE_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginProviderRegistration } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  DEFAULT_AGENT_TURN_PAYLOAD,
  DEFAULT_MESSAGE,
  GMAIL_MODEL,
  expectEmbeddedProviderModel,
  runCronTurn,
  runGmailHookTurn,
  runTurnWithStoredModelOverride,
  withTempHome,
} from "./isolated-agent.turn-test-helpers.js";
import * as isolatedAgentRunRuntime from "./isolated-agent/run.runtime.js";

function installThinkingTestProviders() {
  const registry = createTestRegistry();
  registry.providers = ["anthropic", "google", "openai", "openrouter"].map(
    (providerId): PluginProviderRegistration => ({
      pluginId: providerId,
      source: "test",
      provider: {
        id: providerId,
        label: providerId,
        auth: [],
        resolveThinkingProfile: ({ modelId }) =>
          providerId === "google" && modelId === "gemini-3-flash-preview"
            ? {
                levels: (["off", "minimal", "low", "medium", "adaptive", "high"] as const).map(
                  (id) => ({ id }),
                ),
                preserveWhenCatalogReasoningFalse: true,
              }
            : {
                levels: BASE_THINKING_LEVELS.map((id) => ({ id })),
                defaultLevel: "off",
              },
      },
    }),
  );
  setActivePluginRegistry(registry);
}

function mockDeterministicModelCatalog() {
  vi.mocked(loadModelCatalog).mockResolvedValue([
    {
      id: "gpt-4.1-mini",
      name: "GPT-4.1 Mini",
      provider: "openai",
    },
    {
      id: "claude-opus-4-6",
      name: "Claude Opus 4.5",
      provider: "anthropic",
    },
  ]);
}

const OPENAI_PI_RUNTIME_CONFIG: Partial<OpenClawConfig> = {
  models: {
    providers: {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        agentRuntime: { id: "openclaw" },
        models: [],
      },
    },
  },
};

describe("runCronIsolatedAgentTurn model overrides", () => {
  beforeEach(() => {
    vi.useRealTimers();
    resetPluginRuntimeStateForTest();
    installThinkingTestProviders();
    vi.spyOn(isolatedAgentRunRuntime, "resolveThinkingDefault").mockReturnValue("off");
    vi.mocked(runEmbeddedAgent).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats blank model overrides as unset", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedAgent)).toHaveBeenCalledTimes(1);
    });
  });

  it("applies direct cron model overrides", async () => {
    await withTempHome(async (home) => {
      mockDeterministicModelCatalog();
      const res = (
        await runCronTurn(home, {
          cfgOverrides: OPENAI_PI_RUNTIME_CONFIG,
          jobPayload: {
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            model: "openai/gpt-4.1-mini",
          },
        })
      ).res;
      expect(res.status).toBe("ok");
      const directModel = expectEmbeddedProviderModel({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      directModel.assert();
    });
  });

  it("uses stored model overrides when cron payload omits a model", async () => {
    await withTempHome(async (home) => {
      mockDeterministicModelCatalog();
      const res = (
        await runTurnWithStoredModelOverride(
          home,
          DEFAULT_AGENT_TURN_PAYLOAD,
          "gpt-4.1-mini",
          "openai",
          OPENAI_PI_RUNTIME_CONFIG,
        )
      ).res;
      expect(res.status).toBe("ok");
      const storedOverride = expectEmbeddedProviderModel({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      storedOverride.assert();
    });
  });

  it("lets explicit cron model override stored session overrides", async () => {
    await withTempHome(async (home) => {
      mockDeterministicModelCatalog();
      const res = (
        await runTurnWithStoredModelOverride(home, {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "anthropic/claude-opus-4-6",
        })
      ).res;
      expect(res.status).toBe("ok");
      const explicitOverride = expectEmbeddedProviderModel({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      explicitOverride.assert();
    });
  });

  it("uses hooks.gmail.model and keeps precedence over stored session override", async () => {
    await withTempHome(async (home) => {
      let res = (await runGmailHookTurn(home)).res;
      expect(res.status).toBe("ok");
      const gmailModel = expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
      gmailModel.assert();

      vi.mocked(runEmbeddedAgent).mockClear();
      res = (
        await runGmailHookTurn(home, {
          "agent:main:hook:gmail:msg-1": {
            sessionId: "existing-gmail-session",
            updatedAt: Date.now(),
            providerOverride: "anthropic",
            modelOverride: "claude-opus-4-6",
          },
        })
      ).res;
      expect(res.status).toBe("ok");
      const storedGmailModel = expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
      storedGmailModel.assert();
    });
  });

  it("ignores hooks.gmail.model when not in the allowlist", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-6",
          name: "Opus 4.5",
          provider: "anthropic",
        },
      ]);

      const { res } = await runCronTurn(home, {
        cfgOverrides: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              models: {
                "anthropic/claude-opus-4-6": { alias: "Opus" },
              },
            },
          },
          hooks: {
            gmail: {
              model: GMAIL_MODEL,
            },
          },
        },
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        sessionKey: "hook:gmail:msg-2",
      });

      expect(res.status).toBe("ok");
      const ignoredGmailModel = expectEmbeddedProviderModel({
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      ignoredGmailModel.assert();
    });
  });

  it("rejects invalid model override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "openai/",
        },
        mockTexts: null,
      });

      expect(res.status).toBe("error");
      expect(res.error).toMatch("cron payload.model 'openai/' rejected: invalid model");
      expect(vi.mocked(runEmbeddedAgent)).not.toHaveBeenCalled();
    });
  });

  it("passes through the resolved default thinking level", async () => {
    await withTempHome(async (home) => {
      vi.mocked(isolatedAgentRunRuntime.resolveThinkingDefault).mockReturnValueOnce("low");

      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const calls = vi.mocked(runEmbeddedAgent).mock.calls;
      const callArgs = calls[calls.length - 1]?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("keeps configured Gemini 3 cron thinking when catalog reasoning metadata is stale", async () => {
    await withTempHome(async (home) => {
      vi.mocked(isolatedAgentRunRuntime.resolveThinkingDefault).mockReturnValueOnce("low");
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "gemini-3-flash-preview",
          name: "Gemini 3 Flash Preview",
          provider: "google",
          reasoning: false,
        },
      ]);

      await runCronTurn(home, {
        cfgOverrides: {
          agents: {
            defaults: {
              model: "google/gemini-3-flash-preview",
              workspace: path.join(home, "openclaw"),
              thinkingDefault: "low",
            },
          },
        },
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const calls = vi.mocked(runEmbeddedAgent).mock.calls;
      const callArgs = calls[calls.length - 1]?.[0];
      expect(callArgs?.provider).toBe("google");
      expect(callArgs?.model).toBe("gemini-3-flash-preview");
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });
});
