// PDF maxBytesMb cap and input-validation tests exercise the runtime clamp,
// configured fallback, and reference rejection without loading the full
// pdf-tool.test.ts suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as webMedia from "../../media/web-media.js";
import * as modelAuth from "../model-auth.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
const registerProviderStreamForModelMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return {
    ...actual,
    complete: completeMock,
  };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: registerProviderStreamForModelMock,
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

type PdfToolModule = typeof import("./pdf-tool.js");
let createPdfTool: PdfToolModule["createPdfTool"];

async function loadCreatePdfTool() {
  if (!createPdfTool) {
    ({ createPdfTool } = await import("./pdf-tool.js"));
  }
  return createPdfTool;
}

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";

function requirePdfTool(
  tool: Awaited<ReturnType<typeof loadCreatePdfTool>> extends (...args: any[]) => infer R
    ? R
    : never,
) {
  expect(typeof tool?.execute).toBe("function");
  if (!tool) {
    throw new Error("expected pdf tool");
  }
  return tool;
}

type PdfToolInstance = ReturnType<typeof requirePdfTool>;

async function withConfiguredPdfTool(
  run: (tool: PdfToolInstance, agentDir: string) => Promise<void>,
) {
  await withTempPdfAgentDir(async (agentDir) => {
    const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
    const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));
    await run(tool, agentDir);
  });
}

function withPdfModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { pdfModel: { primary } } },
  } as OpenClawConfig;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function firstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} to be called`);
  }
  return call;
}

describe("pdf-tool maxBytesMb cap and input validation", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
    registerProviderStreamForModelMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects when no pdf input provided", async () => {
    await withConfiguredPdfTool(async (tool) => {
      await expect(tool.execute("t1", { prompt: "test" })).rejects.toThrow("pdf required");
    });
  });

  it("rejects too many PDFs", async () => {
    await withConfiguredPdfTool(async (tool) => {
      const manyPdfs = Array.from({ length: 15 }, (_, i) => `/tmp/doc${i}.pdf`);
      const result = await tool.execute("t1", { prompt: "test", pdfs: manyPdfs });
      expectFields(result.details, { error: "too_many_pdfs" });
    });
  });

  it("rejects invalid maxBytesMb before loading PDFs", async () => {
    await withConfiguredPdfTool(async (tool) => {
      const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");

      await expect(
        tool.execute("t1", {
          prompt: "test",
          pdf: "/tmp/doc.pdf",
          maxBytesMb: 0,
        }),
      ).rejects.toThrow("maxBytesMb must be greater than 0");
      expect(loadSpy).not.toHaveBeenCalled();
    });
  });

  it("passes validated maxBytesMb to PDF loading", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
        maxBytesMb: "0.5",
      });

      const [, loadOptions] = firstMockCall(loadSpy, "loadWebMediaRaw");
      expectFields(loadOptions, { maxBytes: 524_288 });
      expect(modelAuth.getApiKeyForModel).toHaveBeenCalledWith(
        expect.objectContaining({ secretSentinels: true }),
      );
    });
  });

  it("rejects unsupported scheme references", async () => {
    await withConfiguredPdfTool(async (tool) => {
      const result = await tool.execute("t1", {
        prompt: "test",
        pdf: "ftp://example.com/doc.pdf",
      });
      expectFields(result.details, { error: "unsupported_pdf_reference" });
    });
  });

  it("clamps pathological maxBytesMb to the cap", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(ANTHROPIC_PDF_MODEL), agentDir }),
      );

      await tool.execute("t1", { prompt: "ocr", pdf: "/tmp/doc.pdf", maxBytesMb: "1000000000" });
      const [, loadOptions] = firstMockCall(loadSpy, "loadWebMediaRaw");
      expectFields(loadOptions, { maxBytes: 100 * 1024 * 1024 });
    });
  });

  it("real pdf invocation clamps oversized maxBytesMb without schema rejection", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ws-"));
      const pdfPath = path.join(workspaceDir, "doc.pdf");
      await fs.writeFile(pdfPath, FAKE_PDF_MEDIA.buffer);
      try {
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
        const tool = requirePdfTool(
          (await loadCreatePdfTool())({
            config: withPdfModel(ANTHROPIC_PDF_MODEL),
            agentDir,
            workspaceDir,
          }),
        );

        const result = await tool.execute("t1", {
          prompt: "summarize",
          pdf: pdfPath,
          maxBytesMb: "1000000000",
        });

        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
        const [loadRef, loadOptions] = firstMockCall(loadSpy, "loadWebMediaRaw");
        expect(loadRef).toBe(pdfPath);
        expectFields(loadOptions, { maxBytes: 100 * 1024 * 1024 });
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });

  it("uses configuredMaxBytesMb when omitted and passes below-cap through", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");

      // Configured fallback: no model-supplied maxBytesMb
      const cfg = {
        ...withPdfModel(ANTHROPIC_PDF_MODEL),
        agents: {
          defaults: { pdfMaxMb: 50, pdfModel: { primary: ANTHROPIC_PDF_MODEL } },
        },
      } as OpenClawConfig;
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));
      await tool.execute("t1", { prompt: "ocr", pdf: "/tmp/doc.pdf" });
      expectFields(firstMockCall(loadSpy, "loadWebMediaRaw")[1], {
        maxBytes: 50 * 1024 * 1024,
      });

      loadSpy.mockClear();
      await tool.execute("t1", { prompt: "ocr", pdf: "/tmp/doc.pdf", maxBytesMb: "50" });
      expectFields(firstMockCall(loadSpy, "loadWebMediaRaw")[1], {
        maxBytes: 50 * 1024 * 1024,
      });
    });
  });
});
