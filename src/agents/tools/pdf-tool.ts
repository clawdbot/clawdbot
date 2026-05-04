import { type Context, complete } from "@mariozechner/pi-ai";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
} from "../../media/media-reference.js";
import { extractPdfContent, type PdfExtractedContent } from "../../media/pdf-extract.js";
import { loadWebMediaRaw } from "../../media/web-media.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveUserPath } from "../../utils.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { ToolInputError } from "./common.js";
import { coerceImageModelConfig, type ImageModelConfig } from "./image-tool.helpers.js";
import {
  applyImageModelConfigDefaults,
  buildTextToolResult,
  resolveModelFromRegistry,
  resolveMediaToolLocalRoots,
  resolveModelRuntimeApiKey,
  resolvePromptAndModelOverride,
  resolveRemoteMediaSsrfPolicy,
} from "./media-tool-shared.js";
import { hasToolModelConfig } from "./model-config.helpers.js";
import { anthropicAnalyzePdf, geminiAnalyzePdf } from "./pdf-native-providers.js";
import {
  coercePdfAssistantText,
  coercePdfModelConfig,
  parsePageRange,
  providerSupportsNativePdf,
  resolvePdfInputs,
  resolvePdfToolMaxTokens,
} from "./pdf-tool.helpers.js";
import { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";
import {
  createSandboxBridgeReadFile,
  discoverAuthStorage,
  discoverModels,
  ensureOpenClawModelsJson,
  resolveSandboxedBridgeMediaPath,
  runWithImageModelFallback,
  type AnyAgentTool,
  type SandboxedBridgeMediaPathConfig,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";

const DEFAULT_PROMPT = "Analyze this PDF document.";
const DEFAULT_MAX_PDFS = 10;
const DEFAULT_MAX_BYTES_MB = 10;
const DEFAULT_MAX_PAGES = 20;

const PDF_MIN_TEXT_CHARS = 200;
const PDF_MAX_PIXELS = 4_000_000;

export const PdfToolSchema = Type.Object({
  prompt: Type.Optional(Type.String()),
  pdf: Type.Optional(Type.String({ description: "Single PDF path or URL." })),
  pdfs: Type.Optional(
    Type.Array(Type.String(), {
      description: "Multiple PDF paths or URLs (up to 10).",
    }),
  ),
  pages: Type.Optional(
    Type.String({
      description: 'Page range to process, e.g. "1-5", "1,3,5-7". Defaults to all pages.',
    }),
  ),
  model: Type.Optional(Type.String()),
  maxBytesMb: Type.Optional(Type.Number()),
});

// ---------------------------------------------------------------------------
// Model resolution (mirrors image tool pattern)
// ---------------------------------------------------------------------------

export { resolvePdfModelConfigForTool } from "./pdf-tool.model-config.js";

function hasExplicitPdfToolModelConfig(config?: OpenClawConfig): boolean {
  return (
    hasToolModelConfig(coercePdfModelConfig(config)) ||
    hasToolModelConfig(coerceImageModelConfig(config))
  );
}

// ---------------------------------------------------------------------------
// Build context for extraction fallback path
// ---------------------------------------------------------------------------

function buildPdfExtractionContext(prompt: string, extractions: PdfExtractedContent[]): Context {
  const content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];

  // Add extracted text and images
  for (let i = 0; i < extractions.length; i++) {
    const extraction = extractions[i];
    if (extraction.text.trim()) {
      const label = extractions.length > 1 ? `[PDF ${i + 1} text]\n` : "[PDF text]\n";
      content.push({ type: "text", text: label + extraction.text });
    }
    for (const img of extraction.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }

  // Add the user prompt
  content.push({ type: "text", text: prompt });

  return {
    messages: [{ role: "user", content, timestamp: Date.now() }],
  };
}

// ---------------------------------------------------------------------------
// Run PDF prompt with model fallback
// ---------------------------------------------------------------------------

type PdfSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

async function runPdfPrompt(params: {
  cfg?: OpenClawConfig;
  agentDir: string;
  pdfModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  pdfBuffers: Array<{ base64: string; filename: string }>;
  pageNumbers?: number[];
  getExtractions: () => Promise<PdfExtractedContent[]>;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  native: boolean;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg = applyImageModelConfigDefaults(params.cfg, params.pdfModelConfig);

  await ensureOpenClawModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  let extractionCache: PdfExtractedContent[] | null = null;
  const getExtractions = async (): Promise<PdfExtractedContent[]> => {
    if (!extractionCache) {
      extractionCache = await params.getExtractions();
    }
    return extractionCache;
  };

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = resolveModelFromRegistry({ modelRegistry, provider, modelId });
      const apiKey = await resolveModelRuntimeApiKey({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
        authStorage,
      });

      if (providerSupportsNativePdf(provider)) {
        if (params.pageNumbers && params.pageNumbers.length > 0) {
          throw new Error(
            `pages is not supported with native PDF providers (${provider}/${modelId}). Remove pages, or use a non-native model for page filtering.`,
          );
        }

        const pdfs = params.pdfBuffers.map((p) => ({
          base64: p.base64,
          filename: p.filename,
        }));

        if (provider === "anthropic") {
          const text = await anthropicAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }

        if (provider === "google") {
          const text = await geminiAnalyzePdf({
            apiKey,
            modelId,
            prompt: params.prompt,
            pdfs,
            baseUrl: model.baseUrl,
          });
          return { text, provider, model: modelId, native: true };
        }
      }

      const extractions = await getExtractions();
      const hasImages = extractions.some((e) => e.images.length > 0);
      if (hasImages && !model.input?.includes("image")) {
        const hasText = extractions.some((e) => e.text.trim().length > 0);
        if (!hasText) {
          throw new Error(
            `Model ${provider}/${modelId} does not support images and PDF has no extractable text.`,
          );
        }
        const textOnlyExtractions: PdfExtractedContent[] = extractions.map((e) => ({
          text: e.text,
          images: [],
        }));
        const context = buildPdfExtractionContext(params.prompt, textOnlyExtractions);
        const message = await complete(model, context, {
          apiKey,
          maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
        });
        const text = coercePdfAssistantText({ message, provider, model: modelId });
        return { text, provider, model: modelId, native: false };
      }

      const context = buildPdfExtractionContext(params.prompt, extractions);
      const message = await complete(model, context, {
        apiKey,
        maxTokens: resolvePdfToolMaxTokens(model.maxTokens),
      });
      const text = coercePdfAssistantText({ message, provider, model: modelId });
      return { text, provider, model: modelId, native: false };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    native: result.result.native,
    attempts: result.attempts.map((a) => ({
      provider: a.provider,
      model: a.model,
      error: a.error,
    })),
  };
}

// ---------------------------------------------------------------------------
// PDF tool factory
// ---------------------------------------------------------------------------

export function createPdfTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  authProfileStore?: AuthProfileStore;
  workspaceDir?: string;
  sandbox?: PdfSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  /**
   * Avoid resolving auto PDF-provider/model candidates while registering the
   * tool. The concrete PDF model is still resolved before execution.
   */
  deferAutoModelResolution?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  const hasExplicitModelConfig = hasExplicitPdfToolModelConfig(options?.config);
  if (!agentDir) {
    if (hasExplicitModelConfig) {
      throw new Error("createPdfTool requires agentDir when enabled");
    }
    return null;
  }

  const shouldDeferAutoModelResolution =
    options?.deferAutoModelResolution === true && !hasExplicitModelConfig;
  const registrationPdfModelConfig = shouldDeferAutoModelResolution
    ? null
    : resolvePdfModelConfigForTool({
        cfg: options?.config,
        agentDir,
        workspaceDir: options?.workspaceDir,
        authStore: options?.authProfileStore,
      });
  if (!registrationPdfModelConfig && !shouldDeferAutoModelResolution) {
    return null;
  }

  const maxBytesMbDefault = (
    options?.config?.agents?.defaults as Record<string, unknown> | undefined
  )?.pdfMaxBytesMb;
  const maxPagesDefault = (options?.config?.agents?.defaults as Record<string, unknown> | undefined)
    ?.pdfMaxPages;
  const configuredMaxBytesMb =
    typeof maxBytesMbDefault === "number" && Number.isFinite(maxBytesMbDefault)
      ? maxBytesMbDefault
      : DEFAULT_MAX_BYTES_MB;
  const configuredMaxPages =
    typeof maxPagesDefault === "number" && Number.isFinite(maxPagesDefault)
      ? Math.floor(maxPagesDefault)
      : DEFAULT_MAX_PAGES;

  const description =
    "Analyze one or more PDF documents with a model. Supports native PDF analysis for Anthropic and Google models, with text/image extraction fallback for other providers. Use pdf for a single path/URL, or pdfs for multiple (up to 10). Provide a prompt describing what to analyze.";
  const remoteMediaSsrfPolicy = resolveRemoteMediaSsrfPolicy(options?.config);

  return {
    label: "PDF",
    name: "pdf",
    description,
    parameters: PdfToolSchema,
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

      // MARK: - Normalize pdf + pdfs input
      const pdfInputs = resolvePdfInputs(record);

      // Enforce max PDFs cap
      if (pdfInputs.length > DEFAULT_MAX_PDFS) {
        return {
          content: [
            {
              type: "text",
              text: `Too many PDFs: ${pdfInputs.length} provided, maximum is ${DEFAULT_MAX_PDFS}. Please reduce the number.`,
            },
          ],
          details: { error: "too_many_pdfs", count: pdfInputs.length, max: DEFAULT_MAX_PDFS },
        };
      }

      const { prompt: promptRaw, modelOverride } = resolvePromptAndModelOverride(
        record,
        DEFAULT_PROMPT,
      );
      const maxBytesMbRaw = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytesMb =
        typeof maxBytesMbRaw === "number" && Number.isFinite(maxBytesMbRaw) && maxBytesMbRaw > 0
          ? maxBytesMbRaw
          : configuredMaxBytesMb;
      const maxBytes = Math.floor(maxBytesMb * 1024 * 1024);

      // Parse page range
      const pagesRaw = normalizeOptionalString(record.pages);

      const pdfModelConfig =
        registrationPdfModelConfig ??
        resolvePdfModelConfigForTool({
          cfg: options?.config,
          agentDir,
          workspaceDir: options?.workspaceDir,
          authStore: options?.authProfileStore,
        });
      if (!pdfModelConfig) {
        throw new ToolInputError("No PDF model configured.");
      }

      const sandboxConfig: SandboxedBridgeMediaPathConfig | null =
        options?.sandbox && options.sandbox.root.trim()
          ? {
              root: options.sandbox.root.trim(),
              bridge: options.sandbox.bridge,
              workspaceOnly: options.fsPolicy?.workspaceOnly === true,
            }
          : null;

      // MARK: - Load each PDF
      const loadedPdfs: Array<{
        base64: string;
        buffer: Buffer;
        filename: string;
        resolvedPath: string;
        rewrittenFrom?: string;
      }> = [];

      for (const pdfRaw of pdfInputs) {
        const trimmed = normalizeMediaReferenceSource(pdfRaw);
        const refInfo = classifyMediaReferenceSource(trimmed);
        const { isHttpUrl } = refInfo;

        if (refInfo.hasUnsupportedScheme) {
          return {
            content: [
              {
                type: "text",
                text: `Unsupported PDF reference: ${pdfRaw}. Use a file path, file:// URL, or http(s) URL.`,
              },
            ],
            details: { error: "unsupported_pdf_reference", pdf: pdfRaw },
          };
        }

        if (sandboxConfig && isHttpUrl) {
          throw new Error("Sandboxed PDF tool does not allow remote URLs.");
        }

        const resolvedPdf = (() => {
          if (sandboxConfig) {
            return trimmed;
          }
          if (trimmed.startsWith("~")) {
            return resolveUserPath(trimmed);
          }
          return trimmed;
        })();

        const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = sandboxConfig
          ? await resolveSandboxedBridgeMediaPath({
              sandbox: sandboxConfig,
              mediaPath: resolvedPdf,
              inboundFallbackDir: "media/inbound",
            })
          : {
              resolved: resolvedPdf.startsWith("file://")
                ? resolvedPdf.slice("file://".length)
                : resolvedPdf,
            };
        const localRoots = resolveMediaToolLocalRoots(
          options?.workspaceDir,
          {
            workspaceOnly: options?.fsPolicy?.workspaceOnly === true,
          },
          [resolvedPathInfo.resolved],
        );

        const media = sandboxConfig
          ? await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              sandboxValidated: true,
              readFile: createSandboxBridgeReadFile({ sandbox: sandboxConfig }),
            })
          : await loadWebMediaRaw(resolvedPathInfo.resolved, {
              maxBytes,
              localRoots,
              ssrfPolicy: remoteMediaSsrfPolicy,
            });

        if (media.kind !== "document") {
          // Check MIME type more specifically
          const ct = normalizeLowercaseStringOrEmpty(media.contentType);
          if (!ct.includes("pdf") && !ct.includes("application/pdf")) {
            throw new Error(`Expected PDF but got ${media.contentType ?? media.kind}: ${pdfRaw}`);
          }
        }

        const base64 = media.buffer.toString("base64");
        const filename =
          media.fileName ??
          (isHttpUrl
            ? (new URL(trimmed).pathname.split("/").pop() ?? "document.pdf")
            : "document.pdf");

        loadedPdfs.push({
          base64,
          buffer: media.buffer,
          filename,
          resolvedPath: resolvedPathInfo.resolved,
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
        });
      }

      const pageNumbers = pagesRaw ? parsePageRange(pagesRaw, configuredMaxPages) : undefined;

      const getExtractions = async (): Promise<PdfExtractedContent[]> => {
        const extractedAll: PdfExtractedContent[] = [];
        for (const pdf of loadedPdfs) {
          const extracted = await extractPdfContent({
            buffer: pdf.buffer,
            maxPages: configuredMaxPages,
            maxPixels: PDF_MAX_PIXELS,
            minTextChars: PDF_MIN_TEXT_CHARS,
            pageNumbers,
            config: options?.config,
          });
          extractedAll.push(extracted);
        }
        return extractedAll;
      };

      const result = await runPdfPrompt({
        cfg: options?.config,
        agentDir,
        pdfModelConfig,
        modelOverride,
        prompt: promptRaw,
        pdfBuffers: loadedPdfs.map((p) => ({ base64: p.base64, filename: p.filename })),
        pageNumbers,
        getExtractions,
      });

      const pdfDetails =
        loadedPdfs.length === 1
          ? {
              pdf: loadedPdfs[0].resolvedPath,
              ...(loadedPdfs[0].rewrittenFrom
                ? { rewrittenFrom: loadedPdfs[0].rewrittenFrom }
                : {}),
            }
          : {
              pdfs: loadedPdfs.map((p) =>
                Object.assign(
                  { pdf: p.resolvedPath },
                  p.rewrittenFrom ? { rewrittenFrom: p.rewrittenFrom } : {},
                ),
              ),
            };

      return buildTextToolResult(result, { native: result.native, ...pdfDetails });
    },
  };
}
