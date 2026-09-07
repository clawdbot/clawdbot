// Native-provider execution path coverage for the PDF tool: direct document
// hand-off, prepared-runtime reuse and generation scoping, release guarantees,
// and the pages-parameter contract that is exclusive to extraction paths.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as preparedModelRuntime from "../prepared-model-runtime.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  withPreparedRuntimeFacts,
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

const { createPdfModelRegistry, stubPdfToolInfra } = createPdfToolInfraStub(completeMock);

const ANTHROPIC_PDF_MODEL = "anthropic/claude-opus-4-6";
const GOOGLE_PDF_MODEL = "google/gemini-2.5-pro";

type PdfToolModule = typeof import("./pdf-tool.js");
let createPdfTool: PdfToolModule["createPdfTool"];

async function loadCreatePdfTool() {
  if (!createPdfTool) {
    ({ createPdfTool } = await import("./pdf-tool.js"));
  }
  return createPdfTool;
}

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

describe("PDF tool native provider paths", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it("uses native PDF path without eager extraction", async () => {
    // Document-capable providers receive the PDF bytes directly; extraction is
    // reserved for text-only model paths.
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = path.join(agentDir, "workspace");
      await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      const acquirePreparedRuntimeSpy = vi.mocked(
        preparedModelRuntime.acquireAgentRunPreparedModelRuntime,
      );
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");
      const extractSpy = vi.spyOn(pdfExtractModule, "extractPdfContent");
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({
          config: cfg,
          agentId: "researcher",
          agentDir,
          workspaceDir,
        }),
      );

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      const [preparedInput] =
        (acquirePreparedRuntimeSpy as { mock: { calls: unknown[][] } }).mock.calls[0] ?? [];
      expectFields(
        (preparedInput as { config?: { agents?: { defaults?: unknown } } }).config?.agents
          ?.defaults,
        {
          pdfModel: { primary: ANTHROPIC_PDF_MODEL },
        },
      );
      expect(preparedInput).toMatchObject({
        agentId: "researcher",
        agentDir,
        workspaceDir,
      });
      expect(extractSpy).not.toHaveBeenCalled();
      expect(result.content).toEqual([{ type: "text", text: "native summary" }]);
      expectFields(result.details, {
        native: true,
        model: ANTHROPIC_PDF_MODEL,
      });
    });
  });

  it("reuses the parent run generation for PDF execution", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      const authStorage = { setRuntimeApiKey: vi.fn() };
      const find = () => ({
        provider: "anthropic",
        api: "anthropic-messages",
        maxTokens: 8192,
        input: ["text", "document"],
      });
      const modelRegistry = createPdfModelRegistry(find);
      const acquirePreparedRuntimeSpy = vi.mocked(
        preparedModelRuntime.acquireAgentRunPreparedModelRuntime,
      );
      vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("parent summary");
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const parentPreparedModelRuntime = withPreparedRuntimeFacts({
        agentDir,
        config: cfg,
        createStores: () => ({ authStorage, modelRegistry }),
      }) as never;
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({
          config: cfg,
          agentDir,
          preparedModelRuntime: parentPreparedModelRuntime,
        }),
      );

      const result = await tool.execute("t1", { prompt: "summarize", pdf: "/tmp/doc.pdf" });

      expect(result.content).toEqual([{ type: "text", text: "parent summary" }]);
      expect(acquirePreparedRuntimeSpy).not.toHaveBeenCalled();
    });
  });

  it("uses the committed runtime generation for PDF model selection and scope", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const requestedWorkspace = path.join(agentDir, "requested-workspace");
      const committedWorkspace = path.join(agentDir, "committed-workspace");
      await stubPdfToolInfra(agentDir, {
        provider: "google",
        api: "google-generative-ai",
        input: ["text", "document"],
      });
      const authStorage = { setRuntimeApiKey: vi.fn() };
      const find = () => ({
        provider: "google",
        api: "google-generative-ai",
        maxTokens: 8192,
        input: ["text", "document"],
      });
      const modelRegistry = createPdfModelRegistry(find);
      const release = vi.fn();
      vi.mocked(preparedModelRuntime.acquireAgentRunPreparedModelRuntime).mockResolvedValueOnce({
        snapshot: withPreparedRuntimeFacts({
          agentDir: "/tmp/committed-pdf-agent",
          workspaceDir: committedWorkspace,
          config: withPdfModel(GOOGLE_PDF_MODEL),
          createStores: () => ({ authStorage, modelRegistry }),
        }),
        release,
      } as never);
      const geminiSpy = vi
        .spyOn(pdfNativeProviders, "geminiAnalyzePdf")
        .mockResolvedValue("committed native summary");
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({
          config: withPdfModel(ANTHROPIC_PDF_MODEL),
          agentDir,
          workspaceDir: requestedWorkspace,
        }),
      );

      const result = await tool.execute("t1", {
        prompt: "summarize",
        pdf: "/tmp/doc.pdf",
      });

      expect(geminiSpy).toHaveBeenCalledWith(
        expect.objectContaining({ modelId: "gemini-2.5-pro" }),
      );
      expectFields(result.details, { model: GOOGLE_PDF_MODEL, native: true });
      expect(release).toHaveBeenCalledOnce();
    });
  });

  it("releases the prepared runtime when store creation fails", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, {
        provider: "anthropic",
        input: ["text", "document"],
      });
      const release = vi.fn();
      vi.mocked(preparedModelRuntime.acquireAgentRunPreparedModelRuntime).mockResolvedValueOnce({
        snapshot: {
          agentDir,
          config: withPdfModel(ANTHROPIC_PDF_MODEL),
          createStores: () => {
            throw new Error("store fork failed");
          },
        },
        release,
      } as never);
      const tool = requirePdfTool(
        (await loadCreatePdfTool())({
          config: withPdfModel(ANTHROPIC_PDF_MODEL),
          agentDir,
        }),
      );

      await expect(
        tool.execute("t1", { prompt: "summarize", pdf: "/tmp/doc.pdf" }),
      ).rejects.toThrow("store fork failed");
      expect(release).toHaveBeenCalledOnce();
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

  it("rejects explicit page ranges that resolve to no pages before native PDF analysis", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      await stubPdfToolInfra(agentDir, { provider: "anthropic", input: ["text", "document"] });
      const nativeSpy = vi
        .spyOn(pdfNativeProviders, "anthropicAnalyzePdf")
        .mockResolvedValue("native summary");
      const cfg = withPdfModel(ANTHROPIC_PDF_MODEL);
      const tool = requirePdfTool((await loadCreatePdfTool())({ config: cfg, agentDir }));

      await expect(
        tool.execute("t1", {
          prompt: "summarize",
          pdf: "/tmp/doc.pdf",
          pages: "999",
        }),
      ).rejects.toThrow('No PDF pages matched requested range "999"');
      expect(nativeSpy).not.toHaveBeenCalled();
    });
  });
});
