import type { Context, Model } from "@earendil-works/pi-ai";
import type {
  ProviderReplaySessionEntry,
  ProviderSanitizeReplayHistoryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it } from "vitest";
import { registerGoogleGeminiCliProvider } from "./gemini-cli-provider.js";
import googlePlugin from "./index.js";
import { registerGoogleProvider } from "./provider-registration.js";

const googleProviderPlugin = {
  register(api: Parameters<typeof registerGoogleProvider>[0]) {
    registerGoogleProvider(api);
    registerGoogleGeminiCliProvider(api);
  },
};

describe("google provider plugin hooks", () => {
  it("owns replay policy and reasoning mode for the direct Gemini provider", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");
    const customEntries: ProviderReplaySessionEntry[] = [];

    expect(
      provider.buildReplayPolicy?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toEqual({
      sanitizeMode: "full",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      sanitizeThoughtSignatures: {
        allowBase64Only: true,
        includeCamelCase: true,
      },
      repairToolUseResultPairing: true,
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: false,
      allowSyntheticToolResults: true,
    });

    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
      } as never),
    ).toBe("tagged");

    const sanitized = await Promise.resolve(
      provider.sanitizeReplayHistory?.({
        provider: "google",
        modelApi: "google-generative-ai",
        modelId: "gemini-3.1-pro-preview",
        sessionId: "session-1",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        ],
        sessionState: {
          getCustomEntries: () => customEntries,
          appendCustomEntry: (customType: string, data: unknown) => {
            customEntries.push({ customType, data });
          },
        },
      } as ProviderSanitizeReplayHistoryContext),
    );

    const bootstrapMessage = sanitized?.[0] as
      | { role?: string; content?: unknown; timestamp?: unknown }
      | undefined;
    expect(bootstrapMessage?.role).toBe("user");
    expect(bootstrapMessage?.content).toBe("(session bootstrap)");
    expect(typeof bootstrapMessage?.timestamp).toBe("number");
    expect(sanitized?.[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
    });
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]?.customType).toBe("google-turn-ordering-bootstrap");
  });

  it("owns Gemini tool schema normalization for direct and CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const providerIds = ["google", "google-gemini-cli"] as const;

    for (const providerId of providerIds) {
      const provider = requireRegisteredProvider(providers, providerId);
      const [tool] =
        provider.normalizeToolSchemas?.({
          provider: providerId,
          tools: [
            {
              name: "write_file",
              description: "Write a file",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", pattern: "^src/" },
                },
              },
            },
          ],
        } as never) ?? [];

      expect(tool).toEqual({
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
          },
        },
      });
      expect(tool?.parameters).not.toHaveProperty("additionalProperties");
      expect(
        (tool?.parameters as { properties?: { path?: Record<string, unknown> } })?.properties?.path,
      ).not.toHaveProperty("pattern");
      expect(
        provider.inspectToolSchemas?.({
          provider: providerId,
          tools: [tool],
        } as never),
      ).toEqual([]);
    }
  });

  it("wires google-thinking stream hooks for direct and Gemini CLI providers", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");
    const capturedStream = createCapturedThinkingConfigStream();

    const runCase = (provider: typeof googleProvider, providerId: string) => {
      const wrapped = provider.wrapStreamFn?.({
        provider: providerId,
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel: "high",
        streamFn: capturedStream.streamFn,
      } as never);

      void wrapped?.(
        {
          api: "google-generative-ai",
          provider: providerId,
          id: "gemini-3.1-pro-preview",
        } as Model<"google-generative-ai">,
        { messages: [] } as Context,
        {},
      );

      const capturedPayload = capturedStream.getCapturedPayload();
      expect(capturedPayload).toEqual({
        config: {
          thinkingConfig: {
            thinkingLevel: "HIGH",
          },
        },
      });
      const thinkingConfig = (
        (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
      ).thinkingConfig as Record<string, unknown>;
      expect(thinkingConfig).not.toHaveProperty("thinkingBudget");
    };

    runCase(googleProvider, "google");
    runCase(cliProvider, "google-gemini-cli");
  });

  it("advertises adaptive thinking for Gemini dynamic thinking", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const provider = requireRegisteredProvider(providers, "google");
    if (!provider.resolveThinkingProfile) {
      throw new Error("expected Google provider thinking profile resolver");
    }
    const resolveThinkingProfile = provider.resolveThinkingProfile;
    const gemini3Profile = resolveThinkingProfile({
      provider: "google",
      modelId: "gemini-3.1-pro-preview",
    } as never);
    const gemini25Profile = resolveThinkingProfile({
      provider: "google",
      modelId: "gemini-2.5-flash",
    } as never);

    expect(gemini3Profile?.levels).toEqual([
      { id: "off" },
      { id: "low" },
      { id: "adaptive" },
      { id: "high" },
    ]);
    expect(gemini25Profile?.levels).toEqual([
      { id: "off" },
      { id: "minimal" },
      { id: "low" },
      { id: "medium" },
      { id: "adaptive" },
      { id: "high" },
    ]);
  });

  it("shares Gemini replay and stream hooks across Google provider variants", async () => {
    const { providers } = await registerProviderPlugin({
      plugin: googleProviderPlugin,
      id: "google",
      name: "Google Provider",
    });
    const googleProvider = requireRegisteredProvider(providers, "google");
    const cliProvider = requireRegisteredProvider(providers, "google-gemini-cli");

    expect(googleProvider.buildReplayPolicy).toBe(cliProvider.buildReplayPolicy);
    expect(googleProvider.wrapStreamFn).toBe(cliProvider.wrapStreamFn);
  });

  it("buffers early realtime audio while the lazy Google bridge loads", () => {
    let realtimeProvider: RealtimeVoiceProviderPlugin | undefined;
    googlePlugin.register(
      createTestPluginApi({
        registerRealtimeVoiceProvider(provider) {
          realtimeProvider = provider;
        },
      }),
    );

    const bridge = realtimeProvider?.createBridge({
      providerConfig: { apiKey: "gemini-key" },
      onAudio() {},
      onClearAudio() {},
    });

    if (!bridge) {
      throw new Error("expected Google realtime bridge");
    }
    expect(bridge.sendAudio(Buffer.alloc(160))).toBeUndefined();
    expect(bridge.setMediaTimestamp(20)).toBeUndefined();
    expect(bridge.sendUserMessage?.("hello")).toBeUndefined();
  });
});
