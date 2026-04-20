import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import { resetPdfToolAuthEnv } from "./pdf-tool.test-support.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-7";
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
  hasAuthForProvider: ({ provider }: { provider: string }) => {
    if (provider === "anthropic") {
      return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
    }
    if (provider === "openai") {
      return Boolean(process.env.OPENAI_API_KEY);
    }
    if (provider === "google") {
      return Boolean(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
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

  it("returns null without any auth", async () => {
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })).toBeNull();
  });

  it("prefers explicit pdfModel config", async () => {
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

  it("falls back to imageModel config when no pdfModel set", async () => {
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

  it("prefers anthropic when available for native PDF support", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg = withDefaultModel("openai/gpt-5.4");
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });

  it("uses anthropic primary when provider is anthropic", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
    expect(resolvePdfModelConfigForTool({ cfg, agentDir: TEST_AGENT_DIR })?.primary).toBe(
      ANTHROPIC_PDF_MODEL,
    );
  });
});
