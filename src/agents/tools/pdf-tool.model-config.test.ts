import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import { resetPdfToolAuthEnv } from "./pdf-tool.test-support.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-8";
const TEST_AGENT_DIR = "/tmp/openclaw-pdf-model-config";

vi.mock("./model-config.helpers.js", () => ({
  coerceToolModelConfig: (model?: unknown) => {
    if (typeof model === "string") {
      const primary = model.trim();
      return primary ? { primary } : {};
    }
    const objectModel = model as { primary?: string; fallbacks?: string[] } | undefined;
    return {
      ...(objectModel?.primary?.trim() ? { primary: objectModel.primary.trim() } : {}),
      ...(objectModel?.fallbacks?.length ? { fallbacks: objectModel.fallbacks } : {}),
    };
  },
  hasProviderAuthForTool: ({ provider, cfg }: { provider: string; cfg?: OpenClawConfig }) => {
    const providerCfg = cfg?.models?.providers?.[provider] as { apiKey?: string } | undefined;
    if (providerCfg?.apiKey?.trim()) {
      return true;
    }
    if (provider === "anthropic") {
      return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
    }
    if (provider === "openai") {
      return Boolean(process.env.OPENAI_API_KEY);
    }
    if (provider === "google") {
      return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    }
    if (
      provider === "minimax" ||
      provider === "minimax-cn" ||
      provider === "minimax-portal" ||
      provider === "minimax-portal-cn"
    ) {
      return Boolean(process.env.MINIMAX_API_KEY);
    }
    return false;
  },
  resolveDefaultModelRef: (cfg?: OpenClawConfig) => {
    const modelCfg = cfg?.agents?.defaults?.model;
    const primary =
      (typeof modelCfg === "string"
        ? modelCfg
        : (modelCfg as { primary?: string } | undefined)?.primary) ?? "anthropic/claude-sonnet-4-5";
    const [provider = "anthropic", model = "claude-sonnet-4-5"] = primary.split("/", 2);
    return { provider, model };
  },
}));

function withDefaultModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

describe("resolvePdfModelConfigForTool", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns null without any auth", () => {
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toBeNull();
  });

  it("prefers explicit pdfModel config", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          pdfModel: { primary: ANTHROPIC_PDF_MODEL },
        },
      },
    } as OpenClawConfig;
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: ANTHROPIC_PDF_MODEL,
    });
  });

  it("falls back to imageModel config when no pdfModel set", () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          imageModel: { primary: "openai/gpt-5.4-mini" },
        },
      },
    } as OpenClawConfig;
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "openai/gpt-5.4-mini",
    });
  });

  it("prefers anthropic when available for native PDF support", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });

  it("uses anthropic primary when provider is anthropic", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });

  it("uses configured MiniMax chat models for PDF text extraction fallback", () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = {
      ...withDefaultModel("openai/gpt-5.4"),
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "minimax/MiniMax-M2.7",
      fallbacks: ["minimax-portal/MiniMax-M2.7"],
    });
  });

  it("preserves generic image provider precedence when the default model is not MiniMax", () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = {
      ...withDefaultModel("openai/gpt-5.4"),
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [
              {
                id: "MiniMax-M2.7",
                name: "MiniMax M2.7",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["minimax/MiniMax-M2.7", "minimax-portal/MiniMax-M2.7"],
    });
  });

  it("preserves explicit MiniMax text models for PDF text extraction fallback", () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = {
      ...withDefaultModel("minimax/MiniMax-M2.7-highspeed"),
      models: {
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [
              {
                id: "MiniMax-M2.7-highspeed",
                name: "MiniMax M2.7 Highspeed",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "minimax/MiniMax-M2.7-highspeed",
      fallbacks: ["minimax-portal/MiniMax-M2.7"],
    });
  });

  it("preserves explicit MiniMax text models from normalized provider keys", () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = {
      ...withDefaultModel("openai/gpt-5.4"),
      models: {
        providers: {
          Minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            models: [
              {
                id: "MiniMax-M2.7-highspeed",
                name: "MiniMax M2.7 Highspeed",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "minimax/MiniMax-M2.7-highspeed",
      fallbacks: ["minimax-portal/MiniMax-M2.7"],
    });
  });

  it("does not use MiniMax VLM primaries for PDF text extraction fallback", () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = withDefaultModel("minimax/MiniMax-VL-01");

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "minimax/MiniMax-M2.7",
      fallbacks: ["minimax-portal/MiniMax-M2.7"],
    });
  });

  it("uses the default MiniMax chat model for PDF text extraction fallback", () => {
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = {
      ...withDefaultModel("minimax-portal/MiniMax-M2.7"),
      models: {
        providers: {
          "minimax-portal": {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages",
            models: [],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "minimax-portal/MiniMax-M2.7",
      fallbacks: ["minimax/MiniMax-M2.7"],
    });
  });

  it("uses a config-authenticated custom provider image model as a PDF fallback", () => {
    const cfg = {
      ...withDefaultModel("hatchery/text-1"),
      models: {
        providers: {
          hatchery: {
            baseUrl: "https://example.com/v1",
            apiKey: "sk-configured", // pragma: allowlist secret
            models: [
              {
                id: "vision-1",
                name: "Vision 1",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32_000,
                maxTokens: 4_096,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toEqual({
      primary: "hatchery/vision-1",
    });
  });
});
