// Windows integration coverage for host-local file URLs through registered media tools.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as imageGenerationRuntime from "../../image-generation/runtime.js";
import * as mediaStore from "../../media/store.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import { createImageGenerateTool } from "./image-generate-tool.js";
import * as pdfNativeProviders from "./pdf-native-providers.js";
import {
  createPdfToolInfraStub,
  FAKE_PDF_MEDIA,
  resetPdfToolAuthEnv,
  withTempPdfAgentDir,
} from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: vi.fn(),
}));

vi.mock("../openclaw-plugin-tools.js", () => ({
  resolveOpenClawPluginToolsForOptions: () => [],
}));

const { stubPdfToolInfra } = createPdfToolInfraStub(completeMock);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2N5sAAAAASUVORK5CYII=",
  "base64",
);

function requireTool(tools: ReturnType<typeof createOpenClawTools>, name: "image" | "pdf") {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool, `${name} tool registration`).toBeDefined();
  if (!tool) {
    throw new Error(`expected registered ${name} tool`);
  }
  return tool;
}

describe.runIf(process.platform === "win32")("host-local media tool file URLs", () => {
  beforeEach(() => {
    resetPdfToolAuthEnv();
    completeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("loads Unicode and space file URLs through registered image and PDF tools", async () => {
    await withTempPdfAgentDir(async (agentDir) => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-media-file-url-Å "));
      try {
        const imagePath = path.join(workspaceDir, "café image.png");
        const pdfPath = path.join(workspaceDir, "résumé document.pdf");
        await fs.writeFile(imagePath, ONE_PIXEL_PNG);
        await fs.writeFile(pdfPath, FAKE_PDF_MEDIA.buffer);
        await stubPdfToolInfra(agentDir, {
          mockLoad: false,
          provider: "anthropic",
          input: ["text", "document"],
        });
        vi.spyOn(pdfNativeProviders, "anthropicAnalyzePdf").mockResolvedValue("native summary");

        const config: OpenClawConfig = {
          agents: {
            entries: { main: { default: true } },
            defaults: { pdfModel: { primary: "anthropic/claude-opus-4-6" } },
          },
        } as OpenClawConfig;
        const tools = createOpenClawTools({
          agentDir,
          workspaceDir,
          config,
          modelHasVision: true,
          disableMessageTool: true,
          disablePluginTools: true,
          wrapBeforeToolCallHook: false,
        });

        const imageUrl = pathToFileURL(imagePath).href;
        const imageResult = await requireTool(tools, "image").execute("image-call", {
          image: imageUrl,
        });
        expect(imageResult.content).toEqual([
          { type: "text", text: "Loaded 1 image for direct visual inspection." },
          expect.objectContaining({ type: "image" }),
        ]);

        const pdfResult = await requireTool(tools, "pdf").execute("pdf-call", {
          pdf: pathToFileURL(pdfPath).href,
          prompt: "summarize",
        });
        expect(pdfResult.content).toEqual([{ type: "text", text: "native summary" }]);
        expect(pdfResult.details).toMatchObject({ pdf: pdfPath, native: true });

        vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
          {
            id: "fixture",
            defaultModel: "edit",
            models: ["edit"],
            isConfigured: () => true,
            capabilities: {
              generate: { maxCount: 1 },
              edit: { enabled: true, maxInputImages: 1 },
              geometry: {},
            },
            generateImage: vi.fn(async () => {
              throw new Error("runtime generateImage spy should own the call");
            }),
          },
        ]);
        const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
          provider: "fixture",
          model: "edit",
          attempts: [],
          ignoredOverrides: [],
          images: [{ buffer: ONE_PIXEL_PNG, mimeType: "image/png", fileName: "edited.png" }],
        });
        vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
          path: path.join(workspaceDir, "edited.png"),
          id: "edited.png",
          size: ONE_PIXEL_PNG.length,
          contentType: "image/png",
        });
        const generationTool = createImageGenerateTool({
          agentDir,
          workspaceDir,
          config: {
            agents: {
              defaults: {
                mediaModels: { image: { primary: "fixture/edit" } },
              },
            },
          },
        });
        expect(generationTool?.name).toBe("image_generate");
        if (!generationTool) {
          throw new Error("expected image_generate tool");
        }
        await generationTool.execute("generation-call", {
          prompt: "edit the reference",
          image: imageUrl,
        });
        expect(generateImage.mock.calls[0]?.[0]).toEqual(
          expect.objectContaining({
            inputImages: [expect.objectContaining({ buffer: ONE_PIXEL_PNG })],
          }),
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
      }
    });
  });
});
