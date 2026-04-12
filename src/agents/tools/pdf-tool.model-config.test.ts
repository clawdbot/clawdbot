import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import { resetPdfToolAuthEnv, withTempPdfAgentDir } from "./pdf-tool.test-support.js";

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";

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
    await withTempPdfAgentDir(async (agentDir) => {
      const cfg = withDefaultModel("openai/gpt-5.4");
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toBeNull();
    });
  });

  it("prefers explicit pdfModel config", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            pdfModel: { primary: ANTHROPIC_PDF_MODEL },
          },
        },
      } as OpenClawConfig;
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: ANTHROPIC_PDF_MODEL,
      });
    });
  });

  it("falls back to imageModel config when no pdfModel set", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const cfg = {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
            imageModel: { primary: "openai/gpt-5.4-mini" },
          },
        },
      } as OpenClawConfig;
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
    });
  });

  it("prefers anthropic when available for native PDF support", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg = withDefaultModel("openai/gpt-5.4");
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });

  it("uses anthropic primary when provider is anthropic", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg = withDefaultModel(ANTHROPIC_PDF_MODEL);
      expect(resolvePdfModelConfigForTool({ cfg, agentDir })?.primary).toBe(ANTHROPIC_PDF_MODEL);
    });
  });
});
