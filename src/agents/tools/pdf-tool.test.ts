import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import * as modelAuth from "../model-auth.js";
import * as modelsConfig from "../models-config.js";
import * as modelDiscovery from "../pi-model-discovery.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import * as pdfModelConfigModule from "./pdf-tool.model-config.js";
import { resetPdfToolAuthEnv, withTempPdfAgentDir } from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai", async () => {
  const actual =
    await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

type PdfToolModule = typeof import("./pdf-tool.js");
let createPdfTool: PdfToolModule["createPdfTool"];
let PdfToolSchema: PdfToolModule["PdfToolSchema"];

async function loadCreatePdfTool() {
  if (!createPdfTool || !PdfToolSchema) {
    ({ createPdfTool, PdfToolSchema } = await import("./pdf-tool.js"));
  }
  return createPdfTool;
}

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";
const OPENAI_PDF_MODEL = "openai/gpt-5.4-mini";
const CODEX_PDF_MODEL = "openai-codex/gpt-5.4";
const FAKE_PDF_MEDIA = {
  kind: "document",
  buffer: Buffer.from("%PDF-1.4 fake"),
  contentType: "application/pdf",
  fileName: "doc.pdf",
} as const;

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

function withDefaultModel(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

async function stubPdfToolInfra(
  agentDir: string,
  params?: {
    mockLoad?: boolean;
    provider?: string;
    input?: string[];
    api?: string;
    modelFound?: boolean;
  },
) {
  const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");
  if (params?.mockLoad !== false) {
    loadSpy.mockResolvedValue(FAKE_PDF_MEDIA as never);
  }

  vi.spyOn(modelDiscovery, "discoverAuthStorage").mockReturnValue({
    setRuntimeApiKey: vi.fn(),
  } as never);
  const find =
    params?.modelFound === false
      ? () => null
      : () =>
          ({
            provider: params?.provider ?? "anthropic",
            api:
              params?.api ??
              (params?.provider === "openai-codex"
                ? "openai-codex-responses"
                : params?.provider === "openai"
                  ? "openai-responses"
                  : "anthropic-messages"),
            maxTokens: 8192,
            input: params?.input ?? ["text", "document"],
          }) as never;
  vi.spyOn(modelDiscovery, "discoverModels").mockReturnValue({ find } as never);

  vi.spyOn(modelsConfig, "ensureOpenClawModelsJson").mockResolvedValue({
    agentDir,
    wrote: false,
  });

  vi.spyOn(modelAuth, "getApiKeyForModel").mockResolvedValue({ apiKey: "test-key" } as never);
  vi.spyOn(modelAuth, "requireApiKey").mockReturnValue("test-key");

  return { loadSpy };
}

async function withManagedInboundPdf(
  run: (params: { stateDir: string; mediaId: string; mediaPath: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-managed-inbound-"));
  const inboundDir = path.join(stateDir, "media", "inbound");
  const mediaId = "claim-check-test.pdf";
  const mediaPath = path.join(inboundDir, mediaId);
  await fs.mkdir(inboundDir, { recursive: true });
  await fs.writeFile(mediaPath, FAKE_PDF_MEDIA.buffer);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  try {
    await run({ stateDir, mediaId, mediaPath });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("createPdfTool", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("returns null without agentDir and no explicit config", async () => {
    expect((await loadCreatePdfTool())()).toBeNull();
  });

  it("throws when agentDir missing but explicit config present", async () => {
    const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
    const createTool = await loadCreatePdfTool();
    expect(() => createTool({ config: cfg })).toThrow("requires agentDir");
  });

  it("creates tool when a PDF model is configured", async () => {
    await withConfiguredPdfTool(async (tool) => {
      expect(tool.name).toBe("pdf");
      expect(tool.label).toBe("PDF");
      expect(tool.description).toContain("PDF documents");
    });
  });

  it("defers automatic model config resolution during registration (#76644)", async () => {
    const resolveSpy = vi.spyOn(pdfModelConfigModule, "resolvePdfModelConfigForTool");
    const cfg = withDefaultModel("openai/gpt-5.4");
    const authProfileStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "test-key",
        },
      },
    } satisfies AuthProfileStore;
    const createTool = await loadCreatePdfTool();
    await withTempPdfAgentDir(async (agentDir) => {
      expect(
        createTool({
          config: cfg,
          agentDir,
          authProfileStore,
          deferAutoModelResolution: true,
        })?.name,
      ).toBe("pdf");
      expect(resolveSpy).not.toHaveBeenCalled();
    });
    resolveSpy.mockRestore();
  });

  it("keeps explicit model config resolution eager even when automatic resolution is deferred", async () => {
    const resolveSpy = vi.spyOn(pdfModelConfigModule, "resolvePdfModelConfigForTool");
    const createTool = await loadCreatePdfTool();
    await withTempPdfAgentDir(async (agentDir) => {
      expect(
        createTool({
          config: withPdfModel(ANTHROPIC_PDF_MODEL),
          agentDir,
          deferAutoModelResolution: true,
        })?.name,
      ).toBe("pdf");
      expect(resolveSpy).toHaveBeenCalledTimes(1);
    });
    resolveSpy.mockRestore();
  });

  it("resolves deferred model config on execution before loading PDFs", async () => {
    const resolveSpy = vi
      .spyOn(pdfModelConfigModule, "resolvePdfModelConfigForTool")
      .mockReturnValue(null);
    const loadSpy = vi.spyOn(webMedia, "loadWebMediaRaw");
    const createTool = await loadCreatePdfTool();
    const cfg = withDefaultModel("openai/gpt-5.4");
    await withTempPdfAgentDir(async (agentDir) => {
      const tool = requirePdfTool(
        createTool({
          config: cfg,
          agentDir,
          deferAutoModelResolution: true,
        }),
      );
      await expect(
        tool.execute("t1", {
          prompt: "summarize",
          pdf: "/tmp/doc.pdf",
        }),
      ).rejects.toThrow("No PDF model configured.");
    });
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
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

  it("respects fsPolicy.workspaceOnly for non-sandbox pdf paths", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-ws-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pdf-out-"));
      try {
        const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
        const tool = requirePdfTool(
          (await loadCreatePdfTool())({
            config: cfg,
            agentDir,
            workspaceDir,
            fsPolicy: { workspaceOnly: true },
          }),
        );

        const outsidePdf = path.join(outsideDir, "secret.pdf");
        await fs.writeFile(outsidePdf, "%PDF-1.4 fake");

        await expect(tool.execute("t1", { prompt: "test", pdf: outsidePdf })).rejects.toThrow(
          /not under an allowed directory/i,
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
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

  it("resolves media://inbound PDF refs", async () => {
    await withManagedInboundPdf(async ({ mediaId }) => {
      await withTempPdfAgentDir(async (agentDir) => {
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
        const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
        const tool = requirePdfTool(
          (await loadCreatePdfTool())({
            config: cfg,
            agentDir,
            fsPolicy: { workspaceOnly: true },
          }),
        );

        const result = await tool.execute("t1", {
          prompt: "summarize",
          pdf: `media://inbound/${mediaId}`,
        });

        const [loadRef, loadOptions] = loadSpy.mock.calls[0] ?? [];
        expect(loadRef).toBe(`media://inbound/${mediaId}`);
        expectFields(loadOptions, { localRoots: [] });
        expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
        expectFields(result.details, {
          native: true,
          model: ANTHROPIC_PDF_MODEL,
        });
      });
    });
  });

  it("passes web_fetch SSRF policy when loading remote PDFs", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const { loadSpy } = await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const cfg: OpenClawConfig = {
        ...withPdfModel(ANTHROPIC_PDF_MODEL),
        tools: {
          web: {
            fetch: {
              ssrfPolicy: { allowRfc2544BenchmarkRange: true },
            },
          },
        },
      };
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      await tool.execute("t1", {
        prompt: "summarize",
        pdf: "http://198.18.0.153/doc.pdf",
      });

      const [loadRef, loadOptions] = loadSpy.mock.calls[0] ?? [];
      expect(loadRef).toBe("http://198.18.0.153/doc.pdf");
      expectFields(loadOptions, {
        ssrfPolicy: { allowRfc2544BenchmarkRange: true },
      });
    });
  });

  it("allows managed inbound absolute PDF paths when workspaceOnly is enabled", async () => {
    await withManagedInboundPdf(async ({ mediaPath }) => {
      await withTempPdfAgentDir(async (agentDir) => {
        const { loadSpy } = await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
        const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
        const tool = requirePdfTool(
          (await loadCreatePdfTool())({
            config: cfg,
            agentDir,
            fsPolicy: { workspaceOnly: true },
          }),
        );

        await tool.execute("t1", {
          prompt: "summarize",
          pdf: mediaPath,
        });

        const [loadRef, loadOptions] = loadSpy.mock.calls[0] ?? [];
        expect(loadRef).toBe(mediaPath);
        expect(loadOptions).toBeTypeOf("object");
      });
    });
  });

  it("uses native PDF path without eager extraction", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = path.join(agentDir, "workspace");
      await stubPdfToolInfra(agentDir, { provider: "anthropic", input: ["text", "document"] });
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent");
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({ config: cfg, agentDir, workspaceDir }),
      );

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      const ensureModelsJsonMock = vi.mocked(modelsConfig.ensureOpenClawModelsJson);
      const [modelsConfigArg, modelsAgentDir, modelsOptions] =
        ensureModelsJsonMock.mock.calls[0] ?? [];
      expectFields(
        (modelsConfigArg as { agents?: { defaults?: unknown } } | undefined)?.agents?.defaults,
        {
          pdfModel: { primary: ANTHROPIC_PDF_MODEL },
        },
      );
      expect(modelsAgentDir).toBe(agentDir);
      expect(modelsOptions).toEqual({ workspaceDir });
      expect(extractSpy).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
      expectFields(result.details, {
        native: true,
        model: ANTHROPIC_PDF_MODEL,
      });
    });
  });

  it("rejects pages parameter for native PDF providers", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "anthropic", input: ["text", "document"] });
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      await expect(
        tool.execute("t1", {
          prompt: "summarize",
          pdf: "/tmp/doc.pdf",
          pages: "1-2",
        }),
      ).rejects.toThrow("pages is not supported with native PDF providers");
    });
  });

  it("uses extraction fallback for non-native models", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "openai", input: ["text"] });
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "fallback summary" }],
      } as never);

      const cfg = withPdfModel(OPENAI_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(extractSpy).toHaveBeenCalledTimes(1);
      expect(result.content).toEqual([{ type: "text", text: "fallback summary" }]);
      expectFields(result.details, {
        native: false,
        model: OPENAI_PDF_MODEL,
      });
      const [, context] = completeMock.mock.calls[0] ?? [];
      expect(context?.systemPrompt).toBeUndefined();
    });
  });

  it("adds Codex instructions for PDF extraction fallback requests", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai-codex",
        api: "openai-codex-responses",
        input: ["text", "image"],
      });

      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [],
      });

      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "codex summary" }],
      } as never);

      const cfg = withPdfModel(CODEX_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(result.content).toEqual([{ type: "text", text: "codex summary" }]);
      expectFields(result.details, {
        native: false,
        model: CODEX_PDF_MODEL,
      });
      expect(completeMock).toHaveBeenCalledTimes(1);
      const [, context] = completeMock.mock.calls[0] ?? [];
      expect(context?.systemPrompt).toContain("Analyze the provided PDF content");
    });
  });

  it("adds Codex instructions when extraction has images but the model only accepts text", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "openai-codex",
        api: "openai-codex-responses",
        input: ["text"],
      });

      vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
        text: "Extracted content",
        images: [{ type: "image", data: "base64img", mimeType: "image/png" }],
      });

      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "codex summary" }],
      } as never);

      const cfg = withPdfModel(CODEX_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(result.content).toEqual([{ type: "text", text: "codex summary" }]);
      expectFields(result.details, {
        native: false,
        model: CODEX_PDF_MODEL,
      });
      expect(completeMock).toHaveBeenCalledTimes(1);
      const [, context] = completeMock.mock.calls[0] ?? [];
      expect(context?.systemPrompt).toContain("Analyze the provided PDF content");
    });
  });

  it("tool parameters have correct schema shape", async () => {
    await loadCreatePdfTool();
    const schema = PdfToolSchema;
    expect(schema.type).toBe("object");
    expect(schema).toHaveProperty("properties");
    const props = schema.properties as Record<string, { type?: string }>;
    expect(props).toHaveProperty("prompt");
    expect(props).toHaveProperty("pdf");
    expect(props).toHaveProperty("pdfs");
    expect(props).toHaveProperty("pages");
    expect(props).toHaveProperty("model");
    expect(props).toHaveProperty("maxBytesMb");
  });
});
