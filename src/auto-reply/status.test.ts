import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../test/helpers/normalize-text.js";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { MODEL_CONTEXT_TOKEN_CACHE } from "../agents/context-cache.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { createSuccessfulImageMediaDecision } from "./media-understanding.test-fixtures.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildStatusMessage as buildStatusMessageRaw,
} from "./status.js";
import type { buildStatusMessage as BuildStatusMessage } from "./status.js";

const buildStatusMessage: typeof BuildStatusMessage = (args) =>
  buildStatusMessageRaw({
    modelAuth: "api-key",
    activeModelAuth: "api-key",
    ...args,
  });

const { listPluginCommands } = vi.hoisted(() => ({
  listPluginCommands: vi.fn(
    (): Array<{ name: string; description: string; pluginId: string }> => [],
  ),
}));

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands,
}));

afterEach(() => {
  vi.restoreAllMocks();
  MODEL_CONTEXT_TOKEN_CACHE.clear();
});

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            anthropic: {
              apiKey: "test-key",
              models: [
                {
                  id: "pi:opus",
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/pi:opus",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 16_000,
        contextTokens: 32_000,
        thinkingLevel: "low",
        verboseLevel: "on",
        compactionCount: 2,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      now: 10 * 60_000, // 10 minutes later
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("OpenClaw");
    expect(normalized).toContain("Model: anthropic/pi:opus");
    expect(normalized).toContain("api-key");
    expect(normalized).toContain("Tokens: 1.2k in / 800 out");
    expect(normalized).toContain("Cost: $0.0020");
    expect(normalized).toContain("Context: 16k/32k (50%)");
    expect(normalized).toContain("Compactions: 2");
    expect(normalized).toContain("Session: agent:main:main");
    expect(normalized).toContain("updated 10m ago");
    expect(normalized).toContain("Runtime: direct");
    expect(normalized).toContain("Think: medium");
    expect(normalized).not.toContain("verbose");
    expect(normalized).toContain("elevated");
    expect(normalized).toContain("Queue: collect");
  });

  it("falls back to sessionEntry levels when resolved levels are not passed", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/pi:opus",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        thinkingLevel: "high",
        verboseLevel: "full",
        reasoningLevel: "on",
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Think: high");
    expect(normalized).toContain("verbose:full");
    expect(normalized).toContain("Reasoning: on");
  });

  it("shows plugin status lines only when verbose is enabled", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );
    const hidden = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🧩 Active Memory: timeout 15s recent"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(visible).toContain("Active Memory: timeout 15s recent");
    expect(hidden).not.toContain("Active Memory: timeout 15s recent");
  });

  it("shows structured plugin debug lines in verbose status", () => {
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🧩 Active Memory: ok 842ms recent 34 chars"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(visible).toContain("Active Memory: ok 842ms recent 34 chars");
  });

  it("shows trace lines only when trace is enabled", () => {
    const hidden = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: spicy ramen; tacos"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );
    const visible = normalizeTestText(
      buildStatusMessage({
        agent: {
          model: "anthropic/pi:opus",
        },
        sessionEntry: {
          sessionId: "abc",
          updatedAt: 0,
          verboseLevel: "off",
          traceLevel: "on",
          pluginDebugEntries: [
            { pluginId: "active-memory", lines: ["🔎 Active Memory Debug: spicy ramen; tacos"] },
          ],
        },
        sessionKey: "agent:main:main",
        queue: { mode: "collect", depth: 0 },
      }),
    );

    expect(hidden).not.toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("Active Memory Debug: spicy ramen; tacos");
    expect(visible).toContain("trace");
  });

  it("shows fast mode when enabled", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-5.4",
      },
      sessionEntry: {
        sessionId: "fast",
        updatedAt: 0,
        fastMode: true,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Fast: on");
  });

  it("shows configured text verbosity for the active model", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  textVerbosity: "low",
                },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai-codex/gpt-5.4",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Text: low");
  });

  it("shows per-agent text verbosity overrides for the active model", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": {
                params: {
                  textVerbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                text_verbosity: "low",
              },
            },
          ],
        },
      } as unknown as OpenClawConfig,
      agentId: "main",
      agent: {
        model: "openai-codex/gpt-5.4",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
      },
      sessionKey: "agent:main:main",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Text: low");
  });

  it("notes channel model overrides in status output", () => {
    const text = buildStatusMessage({
      config: {
        channels: {
          modelByChannel: {
            discord: {
              "123": "openai/gpt-4.1",
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai/gpt-4.1",
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        channel: "discord",
        groupId: "123",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });
    const normalized = normalizeTestText(text);

    expect(normalized).toContain("Model: openai/gpt-4.1");
    expect(normalized).toContain("channel override");
  });

  it("shows 1M context window when anthropic context1m is enabled", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            model: "anthropic/claude-opus-4-6",
            models: {
              "anthropic/claude-opus-4-6": {
                params: { context1m: true },
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "ctx1m",
        updatedAt: 0,
        totalTokens: 200_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Context: 200k/1.0m");
  });

  it("recomputes context window from the active model after switching away from a smaller session override", () => {
    const sessionEntry = {
      sessionId: "switch-back",
      updatedAt: 0,
      providerOverride: "local",
      modelOverride: "small-model",
      contextTokens: 4_096,
      totalTokens: 1_024,
    };

    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: {
        provider: "local",
        model: "large-model",
        isDefault: true,
      },
    });

    const text = buildStatusMessage({
      agent: {
        model: "local/large-model",
        contextTokens: 65_536,
      },
      sessionEntry,
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Context: 1.0k/66k");
  });

  it("recomputes context window from the active fallback model when session contextTokens are stale", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        sessionId: "fallback-context-window",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        contextTokens: 1_048_576,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps an explicit runtime context limit when fallback status already computed one", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      runtimeContextTokens: 123_456,
      sessionEntry: {
        sessionId: "fallback-context-window-live-limit",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        contextTokens: 1_048_576,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps the persisted runtime context limit for fallback sessions when no live override is passed", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        sessionId: "fallback-context-window-persisted-limit",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        contextTokens: 123_456,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/123k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps an explicit configured context cap for fallback status before runtime snapshot persists", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
        contextTokens: 120_000,
      },
      explicitConfiguredContextTokens: 120_000,
      sessionEntry: {
        sessionId: "fallback-context-window-configured-cap",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/120k");
    expect(normalized).not.toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps an explicit configured context cap even when it matches the selected model window", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 128_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
        contextTokens: 128_000,
      },
      explicitConfiguredContextTokens: 128_000,
      sessionEntry: {
        sessionId: "fallback-context-window-configured-cap-equals-selected",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("clamps an explicit configured context cap to the active fallback window", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "minimax-portal": {
              models: [{ id: "MiniMax-M2.7", contextWindow: 200_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
        contextTokens: 1_048_576,
      },
      explicitConfiguredContextTokens: 1_048_576,
      sessionEntry: {
        sessionId: "fallback-context-window-configured-cap-clamped",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "minimax-portal",
        model: "MiniMax-M2.7",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "minimax-portal/MiniMax-M2.7",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: minimax-portal/MiniMax-M2.7");
    expect(normalized).toContain("Context: 49k/200k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("keeps a persisted fallback limit when the active runtime model lookup is unavailable", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
        contextTokens: 1_048_576,
      },
      explicitConfiguredContextTokens: 1_048_576,
      sessionEntry: {
        sessionId: "fallback-context-window-persisted-unknown-active",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        model: "unknown-fallback-model",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "custom-runtime/unknown-fallback-model",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        contextTokens: 128_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/1.0m");
  });

  it("uses per-agent sandbox config when config and session key are provided", () => {
    const text = buildStatusMessage({
      config: {
        agents: {
          list: [
            { id: "main", default: true },
            { id: "discord", sandbox: { mode: "all" } },
          ],
        },
      } as unknown as OpenClawConfig,
      agent: {},
      sessionKey: "agent:discord:discord:channel:1456350065223270435",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(normalizeTestText(text)).toContain("Runtime: docker/all");
  });

  it("shows verbose/elevated labels only when enabled", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "v1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "low",
      resolvedVerbose: "on",
      resolvedElevated: "on",
      queue: { mode: "collect", depth: 0 },
    });

    expect(text).toContain("verbose");
    expect(text).toContain("elevated");
  });

  it("includes media understanding decisions when present", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        createSuccessfulImageMediaDecision() as unknown as NonNullable<
          Parameters<typeof buildStatusMessage>[0]["mediaDecisions"]
        >[number],
        {
          capability: "audio",
          outcome: "skipped",
          attachments: [
            {
              attachmentIndex: 1,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "maxBytes: too large",
                },
              ],
            },
          ],
        },
      ],
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Media: image ok (openai/gpt-5.4) · audio skipped (maxBytes)");
  });

  it("includes failed media understanding decisions with the surfaced reason", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media-failed", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        {
          capability: "audio",
          outcome: "failed",
          attachments: [
            {
              attachmentIndex: 0,
              attempts: [
                {
                  type: "provider",
                  outcome: "skipped",
                  reason: "empty output",
                },
                {
                  type: "provider",
                  outcome: "failed",
                  reason: "Error: Audio transcription response missing text",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(normalizeTestText(text)).toContain(
      "Media: audio failed (Audio transcription response missing text)",
    );
    expect(normalizeTestText(text)).not.toContain("empty output");
  });

  it("omits media line when all decisions are none", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "media-none", updatedAt: 0 },
      sessionKey: "agent:main:main",
      queue: { mode: "none" },
      mediaDecisions: [
        { capability: "image", outcome: "no-attachment", attachments: [] },
        { capability: "audio", outcome: "no-attachment", attachments: [] },
        { capability: "video", outcome: "no-attachment", attachments: [] },
      ],
    });

    expect(normalizeTestText(text)).not.toContain("Media:");
  });

  it("does not show elevated label when session explicitly disables it", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6", elevatedDefault: "on" },
      sessionEntry: { sessionId: "v1", updatedAt: 0, elevatedLevel: "off" },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "low",
      resolvedVerbose: "off",
      queue: { mode: "collect", depth: 0 },
    });

    const optionsLine = text.split("\n").find((line) => line.trim().startsWith("⚙️"));
    expect(optionsLine).toBeTruthy();
    expect(optionsLine).not.toContain("elevated");
  });

  it("shows selected model and active runtime model when they differ", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "override-1",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNoticeSelectedModel: "openai/gpt-4.1-mini",
        fallbackNoticeActiveModel: "anthropic/claude-haiku-4-5",
        fallbackNoticeReason: "rate limit",
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).toContain("Fallback: anthropic/claude-haiku-4-5");
    expect(normalized).toContain("(rate limit)");
    expect(normalized).not.toContain(" - Reason:");
    expect(normalized).not.toContain("Active:");
    expect(normalized).toContain("di_123...abc");
  });

  it("omits active fallback details when runtime drift does not match fallback state", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-4.1-mini",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "runtime-drift-only",
        updatedAt: 0,
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        fallbackNoticeSelectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
        fallbackNoticeReason: "rate limit",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key di_123…abc (deepinfra:default)",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-4.1-mini");
    expect(normalized).not.toContain("Fallback:");
    expect(normalized).not.toContain("(rate limit)");
  });

  it("omits active lines when runtime matches selected model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "openai/gpt-4.1-mini",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "selected-active-same",
        updatedAt: 0,
        modelProvider: "openai",
        model: "gpt-4.1-mini",
        fallbackNoticeReason: "unknown",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallback:");
  });

  it("shows configured fallback models when provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["google/gemini-2.5-flash", "openai/gpt-5-mini"],
        },
      },
      sessionEntry: { sessionId: "fb1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallbacks: google/gemini-2.5-flash, openai/gpt-5-mini");
  });

  it("omits configured fallbacks line when no fallbacks provided", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: { sessionId: "fb2", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).not.toContain("Fallbacks:");
  });

  it("keeps provider prefix from configured model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "google-antigravity/claude-sonnet-4-6",
      },
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    expect(normalizeTestText(text)).toContain("Model: google-antigravity/claude-sonnet-4-6");
  });

  it("handles missing agent config gracefully", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model:");
    expect(normalized).toContain("Context:");
    expect(normalized).toContain("Queue: collect");
  });

  it("includes group activation for group sessions", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: {
        sessionId: "g1",
        updatedAt: 0,
        groupActivation: "always",
        chatType: "group",
      },
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Activation: always");
  });

  it("shows queue details when overridden", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: { sessionId: "q1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: {
        mode: "collect",
        depth: 3,
        debounceMs: 2000,
        cap: 5,
        dropPolicy: "old",
        showDetails: true,
      },
      modelAuth: "api-key",
    });

    expect(text).toContain("Queue: collect (depth 3 · debounce 2s · cap 5 · drop old)");
  });

  it("inserts usage summary beneath context line", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-6", contextTokens: 32_000 },
      sessionEntry: { sessionId: "u1", updatedAt: 0, totalTokens: 1000 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      usageLine: "📊 Usage: Claude 80% left (5h)",
      modelAuth: "api-key",
    });

    const lines = normalizeTestText(text).split("\n");
    const contextIndex = lines.findIndex((line) => line.includes("Context:"));
    expect(contextIndex).toBeGreaterThan(-1);
    expect(lines[contextIndex + 1]).toContain("Usage: Claude 80% left (5h)");
  });

  it("hides cost when not using an API key", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-opus-4-6",
                  cost: {
                    input: 1,
                    output: 1,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: { sessionId: "c1", updatedAt: 0, inputTokens: 10 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
    });

    expect(text).not.toContain("💵 Cost:");
  });

  function writeTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
    model?: string;
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
    };
  }) {
    const logPath = path.join(
      params.dir,
      ".openclaw",
      "agents",
      params.agentId,
      "sessions",
      `${params.sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            model: params.model ?? "claude-opus-4-6",
            usage: params.usage,
          },
        }),
      ].join("\n"),
      "utf-8",
    );
  }

  const baselineTranscriptUsage = {
    input: 1,
    output: 2,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: 1003,
  } as const;

  function writeBaselineTranscriptUsageLog(params: {
    dir: string;
    agentId: string;
    sessionId: string;
  }) {
    writeTranscriptUsageLog({
      ...params,
      usage: baselineTranscriptUsage,
    });
  }

  function buildTranscriptStatusText(params: { sessionId: string; sessionKey: string }) {
    return buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: params.sessionId,
        updatedAt: 0,
        totalTokens: 3,
        contextTokens: 32_000,
      },
      sessionKey: params.sessionKey,
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      includeTranscriptUsage: true,
      modelAuth: "api-key",
    });
  }

  it("prefers cached prompt tokens from the session log", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-1";
        writeBaselineTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("reads transcript usage for non-default agents", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-worker1";
        writeBaselineTranscriptUsageLog({
          dir,
          agentId: "worker1",
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:worker1:telegram:12345",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("reads transcript usage using explicit agentId when sessionKey is missing", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-worker2";
        writeTranscriptUsageLog({
          dir,
          agentId: "worker2",
          sessionId,
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
            contextTokens: 32_000,
          },
          agentId: "worker2",
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
            contextTokens: 32_000,
          },
          // Intentionally omitted: sessionKey
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        expect(normalizeTestText(text)).toContain("Context: 1.2k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("hydrates cache usage from transcript fallback", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-hydration";
        writeBaselineTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
        });

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("uses the same transcript usage fallback as sessions.list when a delivery mirror is last", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-delivery-mirror";
        const logPath = path.join(
          dir,
          ".openclaw",
          "agents",
          "main",
          "sessions",
          `${sessionId}.jsonl`,
        );
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(
          logPath,
          [
            JSON.stringify({ type: "session", version: 1, id: sessionId }),
            JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                provider: "anthropic",
                model: "claude-opus-4-6",
                usage: {
                  input: 1,
                  output: 2,
                  cacheRead: 1000,
                  cacheWrite: 0,
                  totalTokens: 1003,
                },
              },
            }),
            JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                provider: "openclaw",
                model: "delivery-mirror",
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                },
              },
            }),
          ].join("\n"),
          "utf-8",
        );

        const text = buildTranscriptStatusText({
          sessionId,
          sessionKey: "agent:main:main",
        });

        expect(normalizeTestText(text)).toContain("Cache: 100% hit · 1.0k cached, 0 new");
        expect(normalizeTestText(text)).toContain("Context: 1.0k/32k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("preserves existing nonzero cache usage over transcript fallback values", async () => {
    await withTempHome(
      async (dir) => {
        const sessionId = "sess-cache-preserve";
        writeBaselineTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
        });

        const text = buildStatusMessage({
          agent: {
            model: "anthropic/claude-opus-4-6",
            contextTokens: 32_000,
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 3,
            contextTokens: 32_000,
            cacheRead: 12,
            cacheWrite: 34,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        expect(normalizeTestText(text)).toContain("Cache: 26% hit · 12 cached, 34 new");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps transcript-derived slash model ids on model-only context lookup", async () => {
    await withTempHome(
      async (dir) => {
        MODEL_CONTEXT_TOKEN_CACHE.set("google/gemini-2.5-pro", 999_000);

        const sessionId = "sess-openrouter-google";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          model: "google/gemini-2.5-pro",
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          config: {
            models: {
              providers: {
                google: {
                  models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          agent: {
            model: "openrouter/google/gemini-2.5-pro",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/999k");
        expect(normalized).not.toContain("Context: 1.2k/2.0m");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("keeps runtime slash model ids on model-only context lookup when modelProvider is missing", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("google/gemini-2.5-pro", 999_000);

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            google: {
              models: [{ id: "gemini-2.5-pro", contextWindow: 2_000_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openrouter/google/gemini-2.5-pro",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id",
        updatedAt: 0,
        totalTokens: 1205,
        model: "google/gemini-2.5-pro",
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 1.2k/999k");
    expect(normalized).not.toContain("Context: 1.2k/2.0m");
  });

  it("keeps provider-aware lookup for legacy fallback runtime slash ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.clear();

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "fake-minimax": {
              models: [{ id: "FakeMiniMax-M2.5", contextWindow: 777_000 }],
            },
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 1_048_576 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id-fallback",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        model: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "fake-minimax/FakeMiniMax-M2.5",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: fake-minimax/FakeMiniMax-M2.5");
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for non-fallback runtime slash ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.clear();

    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-4o", contextWindow: 777_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "openai/gpt-4o",
      },
      sessionEntry: {
        sessionId: "sess-runtime-slash-id-direct",
        updatedAt: 0,
        model: "openai/gpt-4o",
        totalTokens: 49_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 49k/777k");
    expect(normalized).not.toContain("Context: 49k/200k");
  });

  it("keeps provider-aware lookup for bare transcript model ids", async () => {
    await withTempHome(
      async (dir) => {
        MODEL_CONTEXT_TOKEN_CACHE.set("gemini-2.5-pro", 128_000);
        MODEL_CONTEXT_TOKEN_CACHE.set("google-gemini-cli/gemini-2.5-pro", 1_000_000);

        const sessionId = "sess-google-bare-model";
        writeTranscriptUsageLog({
          dir,
          agentId: "main",
          sessionId,
          model: "gemini-2.5-pro",
          usage: {
            input: 2,
            output: 3,
            cacheRead: 1200,
            cacheWrite: 0,
            totalTokens: 1205,
          },
        });

        const text = buildStatusMessage({
          agent: {
            model: "google-gemini-cli/gemini-2.5-pro",
          },
          sessionEntry: {
            sessionId,
            updatedAt: 0,
            totalTokens: 5,
          },
          sessionKey: "agent:main:main",
          sessionScope: "per-sender",
          queue: { mode: "collect", depth: 0 },
          includeTranscriptUsage: true,
          modelAuth: "api-key",
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Context: 1.2k/1.0m");
        expect(normalized).not.toContain("Context: 1.2k/128k");
      },
      { prefix: "openclaw-status-" },
    );
  });

  it("prefers provider-qualified context windows for fresh bare model ids", () => {
    MODEL_CONTEXT_TOKEN_CACHE.set("claude-opus-4-6", 200_000);
    MODEL_CONTEXT_TOKEN_CACHE.set("anthropic/claude-opus-4-6", 1_000_000);

    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-6",
      },
      sessionEntry: {
        sessionId: "sess-anthropic-qualified-context",
        updatedAt: 0,
        totalTokens: 25_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Context: 25k/1.0m");
    expect(normalized).not.toContain("Context: 25k/200k");
  });

  it("does not synthesize a 32k fallback window when the active runtime model is unknown", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            xiaomi: {
              models: [{ id: "mimo-v2-flash", contextWindow: 128_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      agent: {
        model: "xiaomi/mimo-v2-flash",
      },
      sessionEntry: {
        sessionId: "fallback-context-window-unknown-active-model",
        updatedAt: 0,
        providerOverride: "xiaomi",
        modelOverride: "mimo-v2-flash",
        modelProvider: "custom-runtime",
        model: "unknown-fallback-model",
        fallbackNoticeSelectedModel: "xiaomi/mimo-v2-flash",
        fallbackNoticeActiveModel: "custom-runtime/unknown-fallback-model",
        fallbackNoticeReason: "model not allowed",
        totalTokens: 49_000,
        contextTokens: 128_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "api-key",
      activeModelAuth: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Fallback: custom-runtime/unknown-fallback-model");
    expect(normalized).toContain("Context: 49k/128k");
    expect(normalized).not.toContain("Context: 49k/32k");
  });
});

describe("buildCommandsMessage", () => {
  it("lists commands with aliases and hints", () => {
    const text = buildCommandsMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("ℹ️ Slash commands");
    expect(text).toContain("Status");
    expect(text).toContain("/commands - List all slash commands.");
    expect(text).toContain("/skill - Run a skill by name.");
    expect(text).toContain("/think (/thinking, /t) - Set thinking level.");
    expect(text).toContain("/compact - Compact the session context.");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes skill commands when provided", () => {
    const text = buildCommandsMessage(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      [
        {
          name: "demo_skill",
          skillName: "demo-skill",
          description: "Demo skill",
        },
      ],
    );
    expect(text).toContain("/demo_skill - Demo skill");
  });
});

describe("buildHelpMessage", () => {
  it("hides config/debug when disabled", () => {
    const text = buildHelpMessage({
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig);
    expect(text).toContain("Skills");
    expect(text).toContain("/skill <name> [input]");
    expect(text).not.toContain("/config");
    expect(text).not.toContain("/debug");
  });

  it("includes /fast in help output", () => {
    expect(buildHelpMessage()).toContain("/fast status|on|off");
  });
});

describe("buildCommandsMessagePaginated", () => {
  it("formats telegram output with pages", () => {
    const result = buildCommandsMessagePaginated(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    expect(result.text).toContain("ℹ️ Commands (1/");
    expect(result.text).toContain("Session");
    expect(result.text).toContain("/stop - Stop the current run.");
  });

  it("includes plugin commands in the paginated list", async () => {
    const pluginCommands = [
      { name: "plugin_cmd", description: "Plugin command", pluginId: "demo-plugin" },
    ];
    listPluginCommands.mockImplementation(() => pluginCommands);
    expect(listPluginCommands()).toEqual(pluginCommands);
    vi.resetModules();
    const { buildCommandsMessagePaginated: buildPaginatedCommands } = await import("./status.js");
    const firstPage = buildPaginatedCommands(
      {
        commands: { config: false, debug: false },
      } as unknown as OpenClawConfig,
      undefined,
      { surface: "telegram", page: 1, forcePaginatedList: true },
    );
    const pages = Array.from({ length: firstPage.totalPages }, (_, index) =>
      buildPaginatedCommands(
        {
          commands: { config: false, debug: false },
        } as unknown as OpenClawConfig,
        undefined,
        { surface: "telegram", page: index + 1, forcePaginatedList: true },
      ),
    );
    const pluginPage = pages.find((page) => page.text.includes("/plugin_cmd (demo-plugin)"));
    expect(pluginPage).toBeTruthy();
    expect(pluginPage?.text).toContain("Plugins");
    expect(pluginPage?.text).toContain("/plugin_cmd (demo-plugin) - Plugin command");
  });
});
