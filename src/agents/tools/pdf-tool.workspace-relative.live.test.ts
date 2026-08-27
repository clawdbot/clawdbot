// Evidence-gated configured-provider probe: lives in a *.live.test.ts file so
// ordinary test discovery never collects credential-bearing cases; run it
// explicitly with EVIDENCE_LLM_* credentials set.
// Configured-provider proof (runs only when evidence credentials are present;
// skipped in CI): the full native chain — relative reference -> shared loader
// -> analyzer — against a live Anthropic-compatible endpoint.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTruthyEnvValue } from "../../infra/env.js";
import { withTempPdfAgentDir } from "./pdf-tool.test-support.js";

// Named opt-in per the repository live-test convention: requires the global
// live gate AND the PDF-specific flag, so broad live discovery cannot run the
// credentialed probe implicitly.
const LIVE =
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_TEST) &&
  isTruthyEnvValue(process.env.OPENCLAW_LIVE_PDF) &&
  Boolean(process.env.EVIDENCE_LLM_API_KEY?.trim()) &&
  Boolean(process.env.EVIDENCE_LLM_BASE_URL_ANTHROPIC?.trim());
const describeLive = LIVE ? describe : describe.skip;

describeLive("PDF tool on a configured live provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a workspace-relative read_pdf with the document's marker via a real model", async () => {
    const baseUrl = process.env.EVIDENCE_LLM_BASE_URL_ANTHROPIC!;
    const markerValue = "evidence-live-90210";
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-evidence-"));
      try {
        await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
        const bytes = Buffer.from(
          "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
            "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
            "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]" +
            "/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
            "4 0 obj<</Length 140>>stream\nBT /F1 14 Tf 10 50 Td (CONFIGURED-MARKER: " +
            markerValue +
            ") Tj ET\nendstream endobj\n" +
            "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF",
          "utf8",
        );
        await fs.writeFile(path.join(workspaceDir, "docs", "evidence.pdf"), bytes);
        const tool = (await import("./pdf-tool.js")).createPdfTool({
          config: {
            models: {
              providers: {
                zhipu: {
                  baseUrl,
                  apiKey: process.env.EVIDENCE_LLM_API_KEY!,
                  api: "anthropic-messages",
                  models: [
                    {
                      id: "glm-5.3-flash",
                      name: "GLM 5.3 Flash",
                      contextWindow: 131_072,
                      maxTokens: 4_096,
                      input: ["text", "document"],
                    },
                  ],
                },
              },
            },
            agents: { defaults: { pdfModel: { primary: "zhipu/glm-5.3-flash" } } },
          } as unknown as import("../../config/types.openclaw.js").OpenClawConfig,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });
        if (!tool) {
          throw new Error("expected PDF tool");
        }

        // The runner cwd stays wherever the harness started; only
        // options.workspaceDir may anchor the relative reference.
        const result = await tool.execute("t1", {
          prompt: "Report the exact CONFIGURED-MARKER value inside this PDF and nothing else.",
          pdf: "docs/evidence.pdf",
        });

        expect(JSON.stringify(result.content)).toContain(markerValue);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});
