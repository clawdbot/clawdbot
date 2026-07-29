// Mock OpenAI Config tests cover shared E2E mock model config helpers.
import { describe, expect, it } from "vitest";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../../scripts/e2e/lib/fixtures/mock-openai-config.mjs";

type MockConfig = {
  agents: {
    defaults: {
      imageModel?: unknown;
      mediaModels?: { image?: unknown; video?: unknown };
      model?: unknown;
      models: Record<string, unknown>;
    };
    entries: Record<
      string,
      {
        model?: string | { primary: string };
        models?: Record<string, { agentRuntime?: unknown; params: Record<string, unknown> }>;
        workspace?: string;
      }
    >;
  };
  models: {
    providers: {
      openai: {
        api?: string;
        apiKey?: unknown;
        baseUrl?: string;
        models?: unknown[];
        request: Record<string, unknown>;
      };
    };
  };
  plugins?: unknown;
};

describe("scripts/e2e/lib/fixtures/mock-openai-config.mjs", () => {
  it("parses strict TCP port values", () => {
    expect(parseMockOpenAiPort("18080")).toBe(18080);
    expect(parseMockOpenAiPort(443)).toBe(443);

    for (const value of [undefined, "", "0", "65536", "1e3", "18080tcp"]) {
      expect(() => parseMockOpenAiPort(value, "test mock port")).toThrow(
        /test mock port must be a TCP port from 1 to 65535/u,
      );
    }
  });

  it("writes mock OpenAI provider and agent defaults", () => {
    const cfg: MockConfig = {
      agents: {
        defaults: {
          mediaModels: { video: { primary: "example/video" } },
          models: {
            "openai/gpt-5.4": { params: { preserved: true } },
          },
        },
        entries: {
          "release-agent": {
            model: { primary: "openai/gpt-5.4" },
            workspace: "/tmp/release-agent",
            models: {
              "openai/gpt-5.5": {
                params: { existing: true },
              },
            },
          },
        },
      },
      models: {
        providers: {
          openai: {
            request: { timeoutMs: 10_000 },
          },
        },
      },
    };

    applyMockOpenAiModelConfig(cfg, {
      includeImageDefaults: true,
      mockPort: "18181",
      modelRef: "openai/gpt-5.5",
    });

    expect(cfg.models.providers.openai).toMatchObject({
      api: "openai-responses",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      baseUrl: "http://127.0.0.1:18181/v1",
      request: { allowPrivateNetwork: true, timeoutMs: 10_000 },
    });
    expect(cfg.models.providers.openai.models).toEqual([
      expect.objectContaining({
        id: "gpt-5.5",
        api: "openai-responses",
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ]);
    expect(cfg.agents.defaults).toMatchObject({
      imageModel: { primary: "openai/gpt-5.5", timeoutMs: 30_000 },
      mediaModels: {
        image: { primary: "openai/gpt-image-1", timeoutMs: 30_000 },
        video: { primary: "example/video" },
      },
      model: { primary: "openai/gpt-5.5" },
      models: {
        "openai/gpt-5.4": { params: { preserved: true } },
        "openai/gpt-5.5": {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    });
    expect(cfg.agents.defaults).not.toHaveProperty("imageGenerationModel");
    expect(cfg.agents.entries["release-agent"]).toMatchObject({
      model: { primary: "openai/gpt-5.5" },
      workspace: "/tmp/release-agent",
      models: {
        "openai/gpt-5.5": {
          agentRuntime: { id: "openclaw" },
          params: { existing: true, transport: "sse", openaiWsWarmup: false },
        },
      },
    });
    expect(cfg.plugins).toEqual({ enabled: true });
  });

  it.each([
    ["string model", "openai/gpt-5.4"],
    ["missing model", undefined],
  ])("rewrites a canonical agent with a %s", (_label, model) => {
    const cfg = {
      agents: {
        defaults: { models: {} },
        entries: {
          main: {
            ...(model === undefined ? {} : { model }),
          },
        },
      },
      models: { providers: {} },
    };

    applyMockOpenAiModelConfig(cfg, { mockPort: 18181 });

    expect(cfg.agents.entries.main).toEqual({
      model: { primary: "openai/gpt-5.6-luna" },
      models: {
        "openai/gpt-5.6-luna": {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        },
      },
    });
  });
});
