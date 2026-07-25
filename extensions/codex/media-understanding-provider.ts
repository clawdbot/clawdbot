/**
 * Codex-backed media understanding provider for bounded image description and
 * structured extraction turns.
 */
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import type {
  ImagesDescriptionRequest,
  ImagesDescriptionResult,
  MediaUnderstandingProvider,
  StructuredExtractionRequest,
  StructuredExtractionResult,
} from "openclaw/plugin-sdk/media-understanding";
import {
  runBoundedCodexAppServerTurn,
  type CodexBoundedTurnOptions,
} from "./src/app-server/bounded-turn.js";
import type { CodexUserInput } from "./src/app-server/protocol.js";

const CODEX_MEDIA_PROVIDER_ID = "codex";
const DEFAULT_CODEX_IMAGE_MODEL = "gpt-5.6-sol";
const DEFAULT_CODEX_IMAGE_PROMPT = "Describe the image.";

type CodexMediaUnderstandingProviderOptions = CodexBoundedTurnOptions;

/**
 * Builds the media-understanding provider that delegates image tasks to an
 * isolated Codex app-server session.
 */
export function buildCodexMediaUnderstandingProvider(
  options: CodexMediaUnderstandingProviderOptions = {},
): MediaUnderstandingProvider {
  return {
    id: CODEX_MEDIA_PROVIDER_ID,
    capabilities: ["image"],
    defaultModels: { image: DEFAULT_CODEX_IMAGE_MODEL },
    describeImage: async (req) =>
      describeCodexImages(
        {
          images: [
            {
              buffer: req.buffer,
              fileName: req.fileName,
              mime: req.mime,
            },
          ],
          provider: req.provider,
          model: req.model,
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          timeoutMs: req.timeoutMs,
          profile: req.profile,
          preferredProfile: req.preferredProfile,
          authStore: req.authStore,
          agentDir: req.agentDir,
          cfg: req.cfg,
        },
        options,
      ),
    describeImages: async (req) => describeCodexImages(req, options),
    extractStructured: async (req) => extractCodexStructured(req, options),
  };
}

async function describeCodexImages(
  req: ImagesDescriptionRequest,
  options: CodexMediaUnderstandingProviderOptions,
): Promise<ImagesDescriptionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex image understanding requires model id.");
  }

  const { text } = await runBoundedCodexAppServerTurn({
    config: req.cfg,
    model: { mode: "required", id: model },
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    agentDir: req.agentDir,
    authProfileStore: req.authStore,
    options,
    taskLabel: "image understanding",
    developerInstructions:
      "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
    input: [
      { type: "text", text: buildCodexImagePrompt(req), text_elements: [] },
      ...req.images.map((image) => ({
        type: "image" as const,
        url: `data:${image.mime ?? "image/png"};base64,${image.buffer.toString("base64")}`,
      })),
    ],
    requiredModalities: ["text", "image"],
    isolation: "configured-transport",
  });
  return { text, model };
}

async function extractCodexStructured(
  req: StructuredExtractionRequest,
  options: CodexMediaUnderstandingProviderOptions,
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Codex structured extraction requires model id.");
  }
  const instructions = req.instructions.trim();
  if (!instructions) {
    throw new Error("Codex structured extraction requires instructions.");
  }
  if (req.input.length === 0) {
    throw new Error("Codex structured extraction requires at least one input.");
  }
  if (!req.input.some((entry) => entry.type === "image")) {
    throw new Error("Codex structured extraction requires at least one image input.");
  }

  const { text } = await runBoundedCodexAppServerTurn({
    config: req.cfg,
    model: { mode: "required", id: model },
    profile: req.profile,
    timeoutMs: req.timeoutMs,
    agentDir: req.agentDir,
    authProfileStore: req.authStore,
    options,
    taskLabel: "structured extraction",
    developerInstructions:
      "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
    input: buildCodexStructuredInput(req),
    requiredModalities: requiredStructuredModalities(),
    isolation: "configured-transport",
  });
  return normalizeStructuredExtractionResult({ text, model, provider: req.provider, req });
}

function buildCodexImagePrompt(req: ImagesDescriptionRequest): string {
  const prompt = req.prompt?.trim() || DEFAULT_CODEX_IMAGE_PROMPT;
  if (req.images.length <= 1) {
    return prompt;
  }
  return `${prompt}\n\nAnalyze all ${req.images.length} images together.`;
}

function requiredStructuredModalities(): string[] {
  return ["text", "image"];
}

function buildCodexStructuredInput(req: StructuredExtractionRequest): CodexUserInput[] {
  return [
    { type: "text", text: buildStructuredExtractionPrompt(req), text_elements: [] },
    ...req.input.map((entry) => {
      if (entry.type === "text") {
        return { type: "text" as const, text: entry.text, text_elements: [] };
      }
      return {
        type: "image" as const,
        url: `data:${entry.mime ?? "image/png"};base64,${entry.buffer.toString("base64")}`,
      };
    }),
  ];
}

function buildStructuredExtractionPrompt(req: StructuredExtractionRequest): string {
  return [
    req.instructions.trim(),
    req.schemaName ? `Schema name: ${req.schemaName}` : undefined,
    req.jsonSchema ? `JSON schema:\n${JSON.stringify(req.jsonSchema)}` : undefined,
    req.jsonMode === false
      ? "Return the extraction as concise text."
      : "Return valid JSON only. Do not wrap the JSON in Markdown fences.",
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStructuredExtractionResult(params: {
  text: string;
  model: string;
  provider: string;
  req: StructuredExtractionRequest;
}): StructuredExtractionResult {
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: params.provider,
    contentType: params.req.jsonMode === false ? "text" : "json",
  };
  if (params.req.jsonMode !== false) {
    try {
      result.parsed = JSON.parse(params.text);
    } catch {
      throw new Error("Codex structured extraction returned invalid JSON.");
    }
    if (isJsonSchemaObject(params.req.jsonSchema)) {
      const validation = validateJsonSchemaValue({
        schema: params.req.jsonSchema,
        cacheKey: "codex.media-understanding.extractStructured",
        value: result.parsed,
        cache: false,
      });
      if (!validation.ok) {
        const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
        throw new Error(`Codex structured extraction JSON did not match schema: ${message}`);
      }
      result.parsed = validation.value;
    }
  }
  return result;
}
