import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { BASE_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
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
  registry.providers = ["anthropic", "openai", "openrouter"].map(
    (providerId): PluginProviderRegistration => ({
      pluginId: providerId,
      source: "test",
      provider: {
        id: providerId,
        label: providerId,
        auth: [],
        resolveThinkingProfile: () => ({
          levels: BASE_THINKING_LEVELS.map((id) => ({ id })),
          defaultLevel: "off",
        }),
      },
    }),
  );
  setActivePluginRegistry(registry);
}

describe("runCronIsolatedAgentTurn model overrides", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    installThinkingTestProviders();
    vi.spyOn(isolatedAgentRunRuntime, "resolveThinkingDefault").mockReturnValue("off");
    vi.mocked(runEmbeddedPiAgent).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("treats blank model overrides as unset", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(1);
    });
  });

  it("applies model overrides with correct precedence", async () => {
    await withTempHome(async (home) => {
      const deterministicCatalog = [
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
      ];
      vi.mocked(loadModelCatalog).mockResolvedValue(deterministicCatalog);

      let res = (
        await runCronTurn(home, {
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

      res = (await runTurnWithStoredModelOverride(home, DEFAULT_AGENT_TURN_PAYLOAD)).res;
      expect(res.status).toBe("ok");
      const storedOverride = expectEmbeddedProviderModel({
        provider: "openai",
        model: "gpt-4.1-mini",
      });
      storedOverride.assert();

      res = (
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

      vi.mocked(runEmbeddedPiAgent).mockClear();
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
      expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();
    });
  });

  it("passes through the resolved default thinking level", async () => {
    await withTempHome(async (home) => {
      vi.mocked(isolatedAgentRunRuntime.resolveThinkingDefault).mockReturnValueOnce("low");

      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const calls = vi.mocked(runEmbeddedPiAgent).mock.calls;
      const callArgs = calls[calls.length - 1]?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });
});
