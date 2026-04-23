import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ImageGenerationProvider,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "openclaw/plugin-sdk/image-generation";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  postMultipartRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { OPENAI_DEFAULT_IMAGE_MODEL as DEFAULT_OPENAI_IMAGE_MODEL } from "./default-models.js";
import { resolveConfiguredOpenAIBaseUrl } from "./shared.js";

const DEFAULT_OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL = "https://chatgpt.com/backend-api/codex";
const OPENAI_CODEX_IMAGE_INSTRUCTIONS = "You are an image generation assistant.";
const DEFAULT_OUTPUT_MIME = "image/png";
const DEFAULT_SIZE = "1024x1024";
const OPENAI_SUPPORTED_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
] as const;
const OPENAI_MAX_INPUT_IMAGES = 5;
const MOCK_OPENAI_PROVIDER_ID = "mock-openai";

const AZURE_HOSTNAME_SUFFIXES = [
  ".openai.azure.com",
  ".services.ai.azure.com",
  ".cognitiveservices.azure.com",
] as const;

const DEFAULT_AZURE_OPENAI_API_VERSION = "2024-12-01-preview";

function isAzureOpenAIBaseUrl(baseUrl?: string): boolean {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const hostname = new URL(trimmed).hostname.toLowerCase();
    return AZURE_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

function resolveAzureApiVersion(): string {
  return process.env.AZURE_OPENAI_API_VERSION?.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
}

function buildAzureImageUrl(
  rawBaseUrl: string,
  model: string,
  action: "generations" | "edits",
): string {
  const cleanBase = rawBaseUrl
    .replace(/\/+$/, "")
    .replace(/\/openai\/v1$/, "")
    .replace(/\/v1$/, "");
  return `${cleanBase}/openai/deployments/${model}/images/${action}?api-version=${resolveAzureApiVersion()}`;
}

function shouldAllowPrivateImageEndpoint(req: {
  provider: string;
  cfg: OpenClawConfig | undefined;
}) {
  if (req.provider === MOCK_OPENAI_PROVIDER_ID) {
    return true;
  }
  const baseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
  if (!baseUrl.startsWith("http://127.0.0.1:") && !baseUrl.startsWith("http://localhost:")) {
    return false;
  }
  return process.env.OPENCLAW_QA_ALLOW_LOCAL_IMAGE_PROVIDER === "1";
}

type OpenAIImageApiResponse = {
  data?: Array<{
    b64_json?: string;
    revised_prompt?: string;
  }>;
};

type OpenAICodexImageGenerationEvent = {
  type?: string;
  item?: {
    type?: string;
    result?: string;
    revised_prompt?: string;
  };
  response?: {
    usage?: unknown;
    tool_usage?: unknown;
  };
  error?: {
    code?: string;
    message?: string;
  };
  message?: string;
};

function inferImageUploadFileName(params: {
  fileName?: string;
  mimeType?: string;
  index: number;
}): string {
  const fileName = params.fileName?.trim();
  if (fileName) {
    return path.basename(fileName);
  }
  const mimeType = params.mimeType?.trim().toLowerCase() || DEFAULT_OUTPUT_MIME;
  const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.replace(/^image\//, "") || "png";
  return `image-${params.index + 1}.${ext}`;
}

function toOpenAIDataUrl(image: ImageGenerationSourceImage): string {
  const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
  return `data:${mimeType};base64,${Buffer.from(image.buffer).toString("base64")}`;
}

async function readResponseBodyText(response: Response): Promise<string> {
  if (!response.body) {
    return await response.text();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        text += decoder.decode(value, { stream: !done });
      }
      if (done) {
        text += decoder.decode();
        return text;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseCodexImageGenerationEvents(body: string): OpenAICodexImageGenerationEvent[] {
  const events: OpenAICodexImageGenerationEvent[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const data = line.slice(6).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      events.push(JSON.parse(data) as OpenAICodexImageGenerationEvent);
    } catch {
      // Ignore non-JSON SSE payloads from intermediaries; failed HTTP statuses
      // are handled before this parser runs.
    }
  }
  return events;
}

function extractCodexImageGenerationResult(params: {
  body: string;
  model: string;
}): ImageGenerationResult {
  const events = parseCodexImageGenerationEvents(params.body);
  const failure = events.find(
    (event) => event.type === "response.failed" || event.type === "error",
  );
  if (failure) {
    const message =
      failure.error?.message ??
      failure.message ??
      (failure.error?.code ? `OpenAI Codex image generation failed (${failure.error.code})` : "");
    throw new Error(message || "OpenAI Codex image generation failed");
  }
  const completedResponse = events.find((event) => event.type === "response.completed");
  const images = events
    .filter(
      (event) =>
        event.type === "response.output_item.done" &&
        event.item?.type === "image_generation_call" &&
        typeof event.item.result === "string" &&
        event.item.result.length > 0,
    )
    .map((event, index) =>
      Object.assign(
        {
          buffer: Buffer.from(event.item?.result ?? "", "base64"),
          mimeType: DEFAULT_OUTPUT_MIME,
          fileName: `image-${index + 1}.png`,
        },
        event.item?.revised_prompt ? { revisedPrompt: event.item.revised_prompt } : {},
      ),
    );

  return {
    images,
    model: params.model,
    ...(completedResponse?.response
      ? {
          metadata: {
            usage: completedResponse.response.usage,
            toolUsage: completedResponse.response.tool_usage,
          },
        }
      : {}),
  };
}

function createOpenAIImageGenerationProviderBase(params: {
  id: "openai" | "openai-codex";
  label: string;
  isConfigured: ImageGenerationProvider["isConfigured"];
  generateImage: ImageGenerationProvider["generateImage"];
}): ImageGenerationProvider {
  return {
    id: params.id,
    label: params.label,
    defaultModel: DEFAULT_OPENAI_IMAGE_MODEL,
    models: [DEFAULT_OPENAI_IMAGE_MODEL],
    isConfigured: params.isConfigured,
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: OPENAI_MAX_INPUT_IMAGES,
        supportsSize: true,
        supportsAspectRatio: false,
        supportsResolution: false,
      },
      geometry: {
        sizes: [...OPENAI_SUPPORTED_SIZES],
      },
    },
    generateImage: params.generateImage,
  };
}

export function buildOpenAIImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAIImageGenerationProviderBase({
    id: "openai",
    label: "OpenAI",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openai",
        agentDir,
      }),
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const isEdit = inputImages.length > 0;
      const auth = await resolveApiKeyForProvider({
        provider: "openai",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenAI API key missing");
      }
      const rawBaseUrl = resolveConfiguredOpenAIBaseUrl(req.cfg);
      const isAzure = isAzureOpenAIBaseUrl(rawBaseUrl);

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: rawBaseUrl,
          defaultBaseUrl: DEFAULT_OPENAI_IMAGE_BASE_URL,
          allowPrivateNetwork: shouldAllowPrivateImageEndpoint(req),
          defaultHeaders: isAzure
            ? { "api-key": auth.apiKey }
            : { Authorization: `Bearer ${auth.apiKey}` },
          provider: "openai",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;
      const url = isAzure
        ? buildAzureImageUrl(rawBaseUrl, model, isEdit ? "edits" : "generations")
        : `${baseUrl}/images/${isEdit ? "edits" : "generations"}`;
      const requestResult = isEdit
        ? await (() => {
            const form = new FormData();
            form.set("model", model);
            form.set("prompt", req.prompt);
            form.set("n", String(count));
            form.set("size", size);
            for (const [index, image] of inputImages.entries()) {
              const mimeType = image.mimeType?.trim() || DEFAULT_OUTPUT_MIME;
              form.append(
                "image[]",
                new Blob([new Uint8Array(image.buffer)], { type: mimeType }),
                inferImageUploadFileName({
                  fileName: image.fileName,
                  mimeType,
                  index,
                }),
              );
            }

            const multipartHeaders = new Headers(headers);
            multipartHeaders.delete("Content-Type");
            return postMultipartRequest({
              url,
              headers: multipartHeaders,
              body: form,
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })()
        : await (() => {
            const jsonHeaders = new Headers(headers);
            jsonHeaders.set("Content-Type", "application/json");
            return postJsonRequest({
              url,
              headers: jsonHeaders,
              body: {
                model,
                prompt: req.prompt,
                n: count,
                size,
              },
              timeoutMs: req.timeoutMs,
              fetchFn: fetch,
              allowPrivateNetwork,
              dispatcherPolicy,
            });
          })();
      const { response, release } = requestResult;
      try {
        await assertOkOrThrowHttpError(
          response,
          isEdit ? "OpenAI image edit failed" : "OpenAI image generation failed",
        );

        const data = (await response.json()) as OpenAIImageApiResponse;
        const images = (data.data ?? [])
          .map((entry, index) => {
            if (!entry.b64_json) {
              return null;
            }
            return Object.assign(
              {
                buffer: Buffer.from(entry.b64_json, `base64`),
                mimeType: DEFAULT_OUTPUT_MIME,
                fileName: `image-${index + 1}.png`,
              },
              entry.revised_prompt ? { revisedPrompt: entry.revised_prompt } : {},
            );
          })
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  });
}

export function buildOpenAICodexImageGenerationProvider(): ImageGenerationProvider {
  return createOpenAIImageGenerationProviderBase({
    id: "openai-codex",
    label: "OpenAI Codex",
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "openai-codex",
        agentDir,
      }),
    async generateImage(req) {
      const inputImages = req.inputImages ?? [];
      const auth = await resolveApiKeyForProvider({
        provider: "openai-codex",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("OpenAI Codex OAuth missing");
      }

      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          defaultBaseUrl: DEFAULT_OPENAI_CODEX_IMAGE_BASE_URL,
          defaultHeaders: {
            Authorization: `Bearer ${auth.apiKey}`,
            Accept: "text/event-stream",
          },
          provider: "openai-codex",
          api: "openai-codex-responses",
          capability: "image",
          transport: "http",
        });

      const model = req.model || DEFAULT_OPENAI_IMAGE_MODEL;
      const count = req.count ?? 1;
      const size = req.size ?? DEFAULT_SIZE;
      headers.set("Content-Type", "application/json");
      const content: Array<Record<string, unknown>> = [
        { type: "input_text", text: req.prompt },
        ...inputImages.map((image) => ({
          type: "input_image",
          image_url: toOpenAIDataUrl(image),
          detail: "auto",
        })),
      ];
      const results: ImageGenerationResult[] = [];
      for (let index = 0; index < count; index += 1) {
        const requestResult = await postJsonRequest({
          url: `${baseUrl}/responses`,
          headers,
          body: {
            model: "gpt-5.4",
            input: [
              {
                role: "user",
                content,
              },
            ],
            instructions: OPENAI_CODEX_IMAGE_INSTRUCTIONS,
            tools: [
              {
                type: "image_generation",
                model,
                size,
              },
            ],
            tool_choice: { type: "image_generation" },
            stream: true,
            store: false,
          },
          timeoutMs: req.timeoutMs,
          fetchFn: fetch,
          allowPrivateNetwork,
          dispatcherPolicy,
        });
        const { response, release } = requestResult;
        try {
          await assertOkOrThrowHttpError(response, "OpenAI Codex image generation failed");
          results.push(
            extractCodexImageGenerationResult({
              body: await readResponseBodyText(response),
              model,
            }),
          );
        } finally {
          await release();
        }
      }
      const images = results.flatMap((result) => result.images);
      return {
        images: images.map((image, index) =>
          Object.assign({}, image, {
            fileName: `image-${index + 1}.png`,
          }),
        ),
        model,
        metadata: {
          responses: results.map((result) => result.metadata).filter(Boolean),
        },
      };
    },
  });
}
