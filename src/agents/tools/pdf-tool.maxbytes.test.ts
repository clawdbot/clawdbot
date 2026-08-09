// PDF maxBytesMb cap and input-validation tests exercise the runtime clamp,
// configured fallback, and reference rejection without loading the full
// pdf-tool.test.ts suite.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { MediaSizeCapExceededError } from "../../media/media-size-cap-error.js";
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

  it("keeps operator pdfMaxMb per-file across multiple PDFs (no aggregate budget)", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        mockLoad: false,
        provider: "anthropic",
        input: ["text", "document"],
      });
      loadSpy.mockImplementation(async () => ({
        ...FAKE_PDF_MEDIA,
        buffer: Buffer.alloc(600_000),
      }));
      const analyzePdfSpy = vi
        .spyOn(pdfNativeProviders, "anthropicAnalyzePdf")
        .mockResolvedValue("native summary");
      const cfg = {
        ...withPdfModel(ANTHROPIC_PDF_MODEL),
        agents: {
          defaults: { pdfMaxMb: 1, pdfModel: { primary: ANTHROPIC_PDF_MODEL } },
        },
      } as OpenClawConfig;
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      const result = await tool.execute("t1", {
        prompt: "ocr",
        pdfs: ["/tmp/a.pdf", "/tmp/b.pdf"],
      });

      // Per-file semantics: every load gets the full per-file cap, both PDFs load.
      expect(loadSpy).toHaveBeenCalledTimes(2);
      for (const call of loadSpy.mock.calls) {
        expectFields(call[1] as Record<string, unknown>, { maxBytes: 1024 * 1024 });
      }
      expect(firstMockCall(analyzePdfSpy, "anthropicAnalyzePdf")[0]).toEqual(
        expect.objectContaining({
          pdfs: [expect.objectContaining({}), expect.objectContaining({})],
        }),
      );
      expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
      expect(result.details?.skippedPdfs).toBeUndefined();
    });
  });

  it("debits the model request budget across PDFs and records the skip", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        mockLoad: false,
        provider: "anthropic",
        input: ["text", "document"],
      });
      // First PDF fits the 1 MB budget; the second exceeds the remainder.
      loadSpy
        .mockImplementationOnce(async () => ({
          ...FAKE_PDF_MEDIA,
          buffer: Buffer.alloc(600_000),
        }))
        .mockRejectedValueOnce(
          new MediaSizeCapExceededError("Media exceeds 0MB limit (got 1MB)", {
            capBytes: 1024 * 1024 - 600_000,
          }),
        );
      const analyzePdfSpy = vi
        .spyOn(pdfNativeProviders, "anthropicAnalyzePdf")
        .mockResolvedValue("native summary");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(ANTHROPIC_PDF_MODEL), agentDir }),
      );

      const result = await tool.execute("t1", {
        prompt: "ocr",
        pdfs: ["/tmp/a.pdf", "/tmp/b.pdf", "/tmp/c.pdf"],
        maxBytesMb: "1",
      });

      // The second load draws only the remaining budget; the third never starts.
      expect(loadSpy).toHaveBeenCalledTimes(2);
      expectFields(loadSpy.mock.calls[0]?.[1] as Record<string, unknown>, {
        maxBytes: 1024 * 1024,
      });
      expectFields(loadSpy.mock.calls[1]?.[1] as Record<string, unknown>, {
        maxBytes: 1024 * 1024 - 600_000,
      });
      expect(firstMockCall(analyzePdfSpy, "anthropicAnalyzePdf")[0]).toEqual(
        expect.objectContaining({ pdfs: [expect.objectContaining({})] }),
      );
      expect(result.content?.[0]?.text).toContain("native summary");
      expect(result.content?.[0]?.text).toContain(
        "Skipped 2 PDF(s): the request byte budget (1 MB total) was exhausted.",
      );
      expectFields(result.details?.skippedPdfs, {
        count: 2,
        budgetBytes: 1024 * 1024,
        reason: "request_budget_exhausted",
      });
    });
  });

  it("stops loading once the model request budget is fully consumed", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        mockLoad: false,
        provider: "anthropic",
        input: ["text", "document"],
      });
      loadSpy.mockImplementation(async () => ({
        ...FAKE_PDF_MEDIA,
        buffer: Buffer.alloc(1024 * 1024),
      }));
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(ANTHROPIC_PDF_MODEL), agentDir }),
      );

      const result = await tool.execute("t1", {
        prompt: "ocr",
        pdfs: ["/tmp/a.pdf", "/tmp/b.pdf"],
        maxBytesMb: "1",
      });

      // The first PDF consumes the whole budget; the second load never starts.
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(result.content?.[0]?.text).toContain("Skipped 1 PDF(s)");
      expectFields(result.details?.skippedPdfs, {
        count: 1,
        budgetBytes: 1024 * 1024,
        reason: "request_budget_exhausted",
      });
    });
  });

  it("returns a recorded non-outcome when every PDF exceeds the model request budget", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        mockLoad: false,
        provider: "anthropic",
        input: ["text", "document"],
      });
      loadSpy.mockRejectedValue(
        new MediaSizeCapExceededError("Media exceeds 1MB limit (got 2MB)", {
          capBytes: 1024 * 1024,
        }),
      );
      const analyzePdfSpy = vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(ANTHROPIC_PDF_MODEL), agentDir }),
      );

      const result = await tool.execute("t1", {
        prompt: "ocr",
        pdfs: ["/tmp/a.pdf", "/tmp/b.pdf"],
        maxBytesMb: "1",
      });

      // No paid model call without loaded PDFs; the skip is recorded instead.
      expect(analyzePdfSpy).not.toHaveBeenCalled();
      expect(result.content?.[0]?.text).toContain("No PDFs were loaded");
      expectFields(result.details, { error: "request_budget_exhausted" });
      expectFields(result.details?.skippedPdfs, {
        count: 2,
        budgetBytes: 1024 * 1024,
        reason: "request_budget_exhausted",
      });
    });
  });

  it("still throws genuine load failures when a model request budget is active", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        mockLoad: false,
        provider: "anthropic",
        input: ["text", "document"],
      });
      loadSpy.mockRejectedValue(new Error("socket hangup"));
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: withPdfModel(ANTHROPIC_PDF_MODEL), agentDir }),
      );

      await expect(
        tool.execute("t1", { prompt: "ocr", pdf: "/tmp/a.pdf", maxBytesMb: "1" }),
      ).rejects.toThrow("socket hangup");
    });
  });
});
