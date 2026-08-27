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

        const [loadRef] = (loadSpy as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
        expect(loadRef).toBe(path.join(workspaceDir, "docs", "guide.pdf"));
        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
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
