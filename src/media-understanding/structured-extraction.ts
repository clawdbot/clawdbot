// Model-backed structured extraction for image-capable providers without a
// bespoke hook: the same shared completion path describeImage/describeImages
// fall back to, with the extraction instructions pinned to the system channel.
import { extractBalancedJsonPrefix } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { completeImagesWithModel } from "./image.js";
import type {
  StructuredExtractionImageInput,
  StructuredExtractionInput,
  StructuredExtractionRequest,
  StructuredExtractionResult,
  StructuredExtractionTextInput,
} from "./types.js";

/**
 * Mirrors the no-secrets rule in the bundled Codex extractor's developer
 * instruction. Logbook feeds full screen captures through here and persists the
 * result, so the shared path must not be the weaker boundary:
 * completeImagesWithModel refuses routes that would demote this into user content.
 */
const STRUCTURED_EXTRACTION_INSTRUCTIONS =
  "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not include secrets such as passwords, API keys, tokens, or credentials, even when they are visible in the input.";

function isStructuredImageInput(
  entry: StructuredExtractionInput,
): entry is StructuredExtractionImageInput {
  return entry.type === "image";
}

function isStructuredTextInput(
  entry: StructuredExtractionInput,
): entry is StructuredExtractionTextInput {
  return entry.type === "text";
}

function buildStructuredExtractionPrompt(req: StructuredExtractionRequest): string {
  return [
    STRUCTURED_EXTRACTION_INSTRUCTIONS,
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

function parseJsonReply(text: string, provider: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Fenced or prose-wrapped replies are common enough that failing the batch
    // on them buys nothing; the first balanced object or array is what the
    // instructions asked for. Anything else stays a controlled error.
  }
  const fragment = extractBalancedJsonPrefix(text, { skipQuotedOpeners: true });
  if (fragment) {
    try {
      return JSON.parse(fragment.json);
    } catch {
      // Not JSON either; report below.
    }
  }
  throw new Error(`Structured extraction returned invalid JSON: ${provider}`);
}

function parseStructuredExtraction(params: {
  text: string;
  model: string;
  req: StructuredExtractionRequest;
}): StructuredExtractionResult {
  const { req } = params;
  const result: StructuredExtractionResult = {
    text: params.text,
    model: params.model,
    provider: req.provider,
    contentType: req.jsonMode === false ? "text" : "json",
  };
  if (req.jsonMode === false) {
    return result;
  }
  result.parsed = parseJsonReply(params.text, req.provider);
  if (isRecord(req.jsonSchema)) {
    const validation = validateJsonSchemaValue({
      schema: req.jsonSchema,
      cacheKey: "media-understanding.extractStructured",
      value: result.parsed,
      cache: false,
    });
    if (!validation.ok) {
      const message = validation.errors.map((error) => error.text).join("; ") || "invalid";
      throw new Error(
        `Structured extraction JSON did not match schema: ${req.provider}: ${message}`,
      );
    }
    result.parsed = validation.value;
  }
  return result;
}

/** Extracts structured data from images through the shared model runtime. */
export async function extractStructuredWithImageModelCore(
  req: StructuredExtractionRequest,
): Promise<StructuredExtractionResult> {
  const model = req.model.trim();
  if (!model) {
    throw new Error("Structured extraction requires model id.");
  }
  if (!req.instructions.trim()) {
    throw new Error("Structured extraction requires instructions.");
  }
  const images = req.input.filter(isStructuredImageInput);
  if (images.length === 0) {
    throw new Error("Structured extraction requires at least one image input.");
  }
  req.signal?.throwIfAborted();
  const { text } = await completeImagesWithModel({
    images: images.map((image) => ({
      buffer: image.buffer,
      fileName: image.fileName,
      mime: image.mime,
    })),
    model,
    provider: req.provider,
    prompt: buildStructuredExtractionPrompt(req),
    promptDelivery: "system-required",
    // Supplemental text is caller data: it rides in user content beside the images.
    userText: req.input
      .filter(isStructuredTextInput)
      .map((entry) => entry.text.trim())
      .filter(Boolean),
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
    profile: req.profile,
    preferredProfile: req.preferredProfile,
    authStore: req.authStore,
    // The dispatcher passes "" when the caller omits agentDir (Logbook does), and
    // the shared runtime keys prepared-model owners by it. Default it here, not
    // in the dispatcher: a bespoke extractor such as Codex must keep receiving "".
    agentDir: req.agentDir || resolveDefaultAgentDir(req.cfg),
    cfg: req.cfg,
  });
  return parseStructuredExtraction({ text, model, req });
}
