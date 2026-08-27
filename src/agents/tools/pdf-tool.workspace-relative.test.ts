// Workspace-relative PDF reference coverage: the non-sandbox resolver must
// anchor relative paths to workspaceDir, matching the image tool behaviour.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";

describe("PDF tool workspace-relative references", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("resolves workspace-relative references against workspaceDir like the image tool", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ws-"));
      try {
        await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "docs", "guide.pdf"), FAKE_PDF_MEDIA.buffer);
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
        const tool = (await import("./pdf-tool.js")).createPdfTool({
          config: { agents: { defaults: { pdfModel: { primary: ANTHROPIC_PDF_MODEL } } } } as never,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });
        if (!tool) {
          throw new Error("expected PDF tool");
        }

        const result = await tool.execute("t1", {
          prompt: "summarize",
          pdf: "docs/guide.pdf",
        });

        const [loadRef, loadOptions] =
          (loadSpy as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
        expect(loadRef).toBe("docs/guide.pdf");
        expect(loadOptions).toMatchObject({ workspaceDir });
        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  it("reads the workspace copy, not a same-relative-path file near process.cwd", async () => {
    // The shared loader must anchor "docs/guide.pdf" to workspaceDir. A
    // decoy with the same relative path sits next to process.cwd(); if the
    // resolver fell back to the runner cwd the decoy bytes would win (or the
    // run would fail with not-found) instead of the workspace payload.
    const nativeSpy = vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf");
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ws-live-"));
      try {
        await fs.mkdir(path.join(workspaceDir, "docs"), { recursive: true });
        const workspaceBytes = Buffer.from("%PDF-1.4 WORKSPACE-ANCHORED", "utf8");
        await fs.writeFile(path.join(workspaceDir, "docs", "guide.pdf"), workspaceBytes);
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        nativeSpy.mockResolvedValue("native summary");
        const tool = (await import("./pdf-tool.js")).createPdfTool({
          config: { agents: { defaults: { pdfModel: { primary: ANTHROPIC_PDF_MODEL } } } } as never,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });
        if (!tool) {
          throw new Error("expected PDF tool");
        }

        const result = await tool.execute("t1", {
          prompt: "summarize",
          pdf: "docs/guide.pdf",
        });

        const [loadRef, loadOptions] =
          (loadSpy as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
        expect(loadRef).toBe("docs/guide.pdf");
        expect(loadOptions).toMatchObject({ workspaceDir });
        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
        const analyzed = nativeSpy.mock.calls[0]?.[0] as
          | { pdfs?: Array<{ base64?: string }> }
          | undefined;
        expect(analyzed?.pdfs?.[0]?.base64).toBe(workspaceBytes.toString("base64"));
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  it("leaves absolute in-workspace references unchanged", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ws-abs-"));
      try {
        const absolute = path.join(workspaceDir, "report.pdf");
        await fs.writeFile(absolute, FAKE_PDF_MEDIA.buffer);
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
        const tool = (await import("./pdf-tool.js")).createPdfTool({
          config: { agents: { defaults: { pdfModel: { primary: ANTHROPIC_PDF_MODEL } } } } as never,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });
        if (!tool) {
          throw new Error("expected PDF tool");
        }

        const result = await tool.execute("t1", { prompt: "summarize", pdf: absolute });

        const [loadRef] = (loadSpy as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
        expect(loadRef).toBe(absolute);
        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});

// Configured-provider proof (runs only when evidence credentials are present;
// skipped in CI): the full native chain — relative reference -> shared loader
// -> analyzer — against a live Anthropic-compatible endpoint.
const maybeNative =
  process.env.EVIDENCE_LLM_API_KEY && process.env.EVIDENCE_LLM_BASE_URL_ANTHROPIC
    ? describe
    : describe.skip;

maybeNative("PDF tool on a configured live provider", () => {
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

        // Runner cwd stays at the repo root; only workspaceDir anchors the
        // relative reference.
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
