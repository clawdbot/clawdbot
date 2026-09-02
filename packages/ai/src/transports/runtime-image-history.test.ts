import { createServer } from "node:http";
import { withRuntimeImageHistory } from "@openclaw/media-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamAnthropic } from "../providers/anthropic.js";
import { streamGoogle } from "../providers/google.js";
import { streamMistral } from "../providers/mistral.js";
import { streamOpenAICodexResponses } from "../providers/openai-chatgpt-responses.js";
import { streamOpenAICompletions } from "../providers/openai-completions.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import type { Api, Context, ImageContent, Model, StreamFn, StreamOptions } from "../types.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
// Complete 1x1, 24-bit BI_RGB bitmap, including its padded pixel row.
const BMP = "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAAAAD/AA==";
const REPLACEMENT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const QUESTION = "What was in the retained photo?";
const SOURCE = { key: "retained-H\0history.png", sourceText: "from Ada, message retained-H" };
const NOTE = "[Recent image 1 from Ada, message retained-H, attached as media.]";
const IMAGE_OMISSION = "[omitted image payload: invalid inline image data]";

type Protocol = "responses" | "chat" | "anthropic" | "google" | "mistral";
type HookAction = "keep" | "remove" | "clone" | "ordinary" | "replace";

function model<T extends Api>(api: T, baseUrl: string): Model<T> {
  return {
    id: "retained-image-model",
    name: "Retained image fixture",
    api,
    provider: "retained-image-fixture",
    baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 128,
  };
}

type RunFixture = (
  baseUrl: string,
  context: Context,
  options: StreamOptions,
) => ReturnType<StreamFn>;

const nativeResponses = createOpenAIResponsesTransportStreamFn();
const nativeChat = createOpenAICompletionsTransportStreamFn();
const nativeAnthropic = createAnthropicMessagesTransportStreamFn();
const chatGptToken = [
  Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "image-fixture" } }),
  ).toString("base64url"),
  "signature",
].join(".");

const fixtures = [
  {
    name: "native Responses",
    protocol: "responses",
    path: "/v1/responses",
    run: (baseUrl, context, options) =>
      nativeResponses(model("openai-responses", `${baseUrl}/v1`), context, options),
  },
  {
    name: "provider Responses",
    protocol: "responses",
    path: "/v1/responses",
    run: (baseUrl, context, options) =>
      streamOpenAIResponses(model("openai-responses", `${baseUrl}/v1`), context, options),
  },
  {
    name: "ChatGPT Responses SSE",
    protocol: "responses",
    path: "/codex/responses",
    run: (baseUrl, context, options) =>
      streamOpenAICodexResponses(model("openai-chatgpt-responses", baseUrl), context, {
        ...options,
        apiKey: chatGptToken,
        transport: "sse",
      }),
  },
  {
    name: "native Chat",
    protocol: "chat",
    path: "/v1/chat/completions",
    run: (baseUrl, context, options) =>
      nativeChat(model("openai-completions", `${baseUrl}/v1`), context, options),
  },
  {
    name: "provider Chat",
    protocol: "chat",
    path: "/v1/chat/completions",
    run: (baseUrl, context, options) =>
      streamOpenAICompletions(model("openai-completions", `${baseUrl}/v1`), context, options),
  },
  {
    name: "native Anthropic",
    protocol: "anthropic",
    path: "/v1/messages",
    run: (baseUrl, context, options) =>
      nativeAnthropic(model("anthropic-messages", baseUrl), context, options),
  },
  {
    name: "provider Anthropic",
    protocol: "anthropic",
    path: "/v1/messages",
    run: (baseUrl, context, options) =>
      streamAnthropic(model("anthropic-messages", baseUrl), context, options),
  },
  {
    name: "Google",
    protocol: "google",
    path: "/v1beta/models/retained-image-model:streamGenerateContent?alt=sse",
    run: (baseUrl, context, options) =>
      streamGoogle(model("google-generative-ai", `${baseUrl}/v1beta`), context, options),
  },
  {
    name: "Mistral",
    protocol: "mistral",
    path: "/v1/chat/completions",
    run: (baseUrl, context, options) =>
      streamMistral(model("mistral-conversations", baseUrl), context, options),
  },
] as const satisfies ReadonlyArray<{
  name: string;
  protocol: Protocol;
  path: string;
  run: RunFixture;
}>;

function messageParts(payload: unknown, protocol: Protocol): unknown[] {
  if (!isRecord(payload)) {
    throw new Error("Expected a request object");
  }
  const messages =
    protocol === "google"
      ? payload.contents
      : protocol === "responses"
        ? payload.input
        : payload.messages;
  if (!Array.isArray(messages)) {
    throw new Error("Expected request messages");
  }
  const users = messages.filter((message) => isRecord(message) && message.role === "user");
  expect(users).toHaveLength(1);
  const user = users[0];
  if (!isRecord(user)) {
    throw new Error("Expected a user message");
  }
  const parts = protocol === "google" ? user.parts : user.content;
  if (!Array.isArray(parts)) {
    throw new Error("Expected user content parts");
  }
  return parts;
}

function completedResponse(protocol: Protocol): string {
  let events: Array<Record<string, unknown> & { type?: string }>;
  if (protocol === "responses") {
    const response = {
      id: "resp_image_fixture",
      object: "response",
      status: "completed",
      model: "retained-image-model",
      output: [
        {
          id: "msg_image_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    };
    events = [
      { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
      { type: "response.completed", response },
    ];
  } else if (protocol === "anthropic") {
    events = [
      {
        type: "message_start",
        message: {
          id: "msg_image_fixture",
          type: "message",
          role: "assistant",
          model: "retained-image-model",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
  } else if (protocol === "google") {
    events = [
      {
        candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      },
    ];
  } else {
    events = [
      {
        id: "chatcmpl_image_fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "retained-image-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];
  }
  return events
    .map(
      (event) =>
        `${event.type !== undefined ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
    )
    .join("");
}

async function captureRequest(
  fixture: (typeof fixtures)[number],
  action: HookAction,
  image: ImageContent = { type: "image", mimeType: "image/png", data: PNG },
  extra: {
    precedingImages?: ImageContent[];
    onPayload?: (parts: unknown[]) => void;
  } = {},
): Promise<unknown[]> {
  const originalImageJson = JSON.stringify(image);
  const currentImage = action === "ordinary" ? image : withRuntimeImageHistory(image, SOURCE);
  const context: Context = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: QUESTION }, ...(extra.precedingImages ?? []), currentImage],
        timestamp: 1,
      },
    ],
  };
  const originalContextJson = JSON.stringify(context);
  const requests: Array<{ method?: string; path?: string; body: string }> = [];
  let hookCalls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completedResponse(fixture.protocol));
    });
  });
  const previousHost = getAiTransportHost();
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture has no loopback address");
    }
    configureAiTransportHost({
      buildModelFetch: () => globalThis.fetch,
      // The host owns normalization. Exercise its supported replacement-object
      // result without changing bytes or pretending this is a format conversion.
      normalizeAnthropicInlineContentBlocks: async (blocks) =>
        blocks.map((block) => ({ ...block })),
    });
    const stream = await fixture.run(`http://127.0.0.1:${address.port}`, context, {
      apiKey: "synthetic-loopback-only",
      cacheRetention: "none",
      timeoutMs: 2_000,
      signal: abort.signal,
      onPayload: (payload) => {
        hookCalls += 1;
        const parts = messageParts(payload, fixture.protocol);
        expect(parts).toHaveLength(2 + (extra.precedingImages?.length ?? 0));
        expect(parts[0]).toMatchObject({ text: QUESTION });
        const imagePart = parts.at(-1);
        if (!isRecord(imagePart)) {
          throw new Error("Expected the converted image before the payload hook");
        }
        if (image.mimeType === "image/bmp") {
          expect(imagePart).toEqual({
            type: "input_image",
            detail: "auto",
            image_url: `data:image/bmp;base64,${BMP}`,
          });
        }
        extra.onPayload?.(parts);
        if (action === "remove") {
          parts.splice(1, 1);
        } else if (action === "replace") {
          const replacementUrl = `data:image/png;base64,${REPLACEMENT_PNG}`;
          if (fixture.protocol === "responses") {
            imagePart.image_url = replacementUrl;
          } else if (fixture.protocol === "mistral") {
            imagePart.imageUrl = replacementUrl;
          } else if (fixture.protocol === "chat") {
            if (!isRecord(imagePart.image_url)) {
              throw new Error("Expected the native Chat image URL object");
            }
            imagePart.image_url.url = replacementUrl;
          } else if (fixture.protocol === "anthropic") {
            if (!isRecord(imagePart.source)) {
              throw new Error("Expected the native Anthropic image source");
            }
            imagePart.source.data = REPLACEMENT_PNG;
          } else {
            if (!isRecord(imagePart.inlineData)) {
              throw new Error("Expected the native Google image data");
            }
            imagePart.inlineData.data = REPLACEMENT_PNG;
          }
        } else if (action === "clone") {
          if (!isRecord(payload)) {
            throw new Error("Expected a request object");
          }
          const field =
            fixture.protocol === "google"
              ? "contents"
              : fixture.protocol === "responses"
                ? "input"
                : "messages";
          // Clone wire messages without serializing SDK-only objects such as AbortSignal.
          return { ...payload, [field]: structuredClone(payload[field]) };
        }
        return undefined;
      },
    });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(hookCalls).toBe(1);
    expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: fixture.path },
    ]);
    expect(JSON.stringify(context)).toBe(originalContextJson);
    expect(JSON.stringify(currentImage)).toBe(originalImageJson);
    const request = requests[0];
    if (!request) {
      throw new Error("transport produced no HTTP request");
    }
    return messageParts(JSON.parse(request.body) as unknown, fixture.protocol);
  } finally {
    abort.abort();
    configureAiTransportHost(previousHost);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function expectedParts(protocol: Protocol, action: HookAction): object[] {
  const text = action === "keep" || action === "clone" ? `${QUESTION}\n\n${NOTE}` : QUESTION;
  const textPart =
    protocol === "google"
      ? { text }
      : { type: protocol === "responses" ? "input_text" : "text", text };
  if (action === "remove") {
    return [textPart];
  }
  const data = action === "replace" ? REPLACEMENT_PNG : PNG;
  const dataUrl = `data:image/png;base64,${data}`;
  const imagePart =
    protocol === "responses"
      ? { type: "input_image", detail: "auto", image_url: dataUrl }
      : protocol === "anthropic"
        ? { type: "image", source: { type: "base64", media_type: "image/png", data } }
        : protocol === "google"
          ? { inlineData: { mimeType: "image/png", data } }
          : { type: "image_url", image_url: protocol === "mistral" ? dataUrl : { url: dataUrl } };
  return [textPart, imagePart];
}

describe.each(fixtures)("$name retained image HTTP projection", (fixture) => {
  it.each(["keep", "remove", "clone", "ordinary", "replace"] as const)(
    "matches actual image parts after payload action %s",
    async (action) => {
      expect(await captureRequest(fixture, action)).toEqual(
        expectedParts(fixture.protocol, action),
      );
    },
  );
});

describe("native Responses final image format decision", () => {
  it.each(["keep", "clone"] as const)(
    "retains the source through canonical MIME normalization after %s",
    async (action) => {
      const parts = await captureRequest(
        fixtures[0],
        action,
        {
          type: "image",
          mimeType: "image/jpeg",
          data: PNG,
        },
        {
          onPayload: (input) => {
            expect(input[1]).toEqual({
              type: "input_image",
              detail: "auto",
              image_url: `data:image/jpeg;base64,${PNG}`,
            });
          },
        },
      );
      expect(parts).toEqual(expectedParts("responses", "keep"));
    },
  );

  it.each(["keep", "clone"] as const)(
    "omits provenance when a complete retained BMP is removed after payload action %s",
    async (action) => {
      const fixture = fixtures[0];
      const parts = await captureRequest(fixture, action, {
        type: "image",
        mimeType: "image/bmp",
        data: BMP,
      });
      expect(parts).toEqual([
        { type: "input_text", text: QUESTION },
        { type: "input_text", text: IMAGE_OMISSION },
      ]);
    },
  );
});

const OTHER_SOURCE = { key: "retained-J\0other.png", sourceText: "from Grace, message retained-J" };
const OTHER_SECOND_NOTE = "[Recent image 2 from Grace, message retained-J, attached as media.]";
const ordinaryImage = (data = PNG): ImageContent => ({
  type: "image",
  mimeType: "image/png",
  data,
});

describe("native Responses image occurrence provenance", () => {
  const cases = [
    {
      name: "keeps an ordinary and retained image with identical bytes distinct",
      preceding: () => ordinaryImage(),
      data: [PNG, PNG],
      notes: NOTE,
    },
    {
      name: "follows exact identities when two retained sources with identical bytes are reordered",
      preceding: () => withRuntimeImageHistory(ordinaryImage(), OTHER_SOURCE),
      rewrite: (parts) => {
        parts.splice(1, 2, parts[2], parts[1]);
      },
      data: [PNG, PNG],
      notes: `${NOTE}\n${OTHER_SECOND_NOTE}`,
    },
    {
      name: "reserves a later ordinary identity before matching a retained clone",
      preceding: () => ordinaryImage(),
      rewrite: (parts) => {
        parts.splice(1, 2, structuredClone(parts[2]), parts[1]);
      },
      data: [PNG, PNG],
      notes: NOTE,
    },
    {
      name: "keeps a retained identity when the identical ordinary image is cloned",
      preceding: () => ordinaryImage(),
      rewrite: (parts) => {
        parts[1] = structuredClone(parts[1]);
      },
      data: [PNG, PNG],
      notes: NOTE,
    },
    {
      name: "leaves all-clone ordinary and retained occurrences unannotated when bytes coincide",
      preceding: () => ordinaryImage(),
      rewrite: (parts) => {
        parts.splice(1, 2, ...structuredClone(parts.slice(1)));
      },
      data: [PNG, PNG],
      notes: "",
    },
    {
      name: "does not assign a removed retained origin to an identical ordinary clone",
      preceding: () => ordinaryImage(),
      rewrite: (parts) => {
        parts.splice(1, 2, structuredClone(parts[1]));
      },
      data: [PNG],
      notes: "",
    },
    {
      name: "recovers the retained clone when ordinary bytes are different",
      preceding: () => ordinaryImage(REPLACEMENT_PNG),
      rewrite: (parts) => {
        parts.splice(1, 2, ...structuredClone(parts.slice(1)));
      },
      data: [REPLACEMENT_PNG, PNG],
      notes: NOTE,
    },
    {
      name: "leaves cloned identical bytes with conflicting source histories unannotated",
      preceding: () => withRuntimeImageHistory(ordinaryImage(), OTHER_SOURCE),
      rewrite: (parts) => {
        parts.splice(1, 2, ...structuredClone(parts.slice(1)));
      },
      data: [PNG, PNG],
      notes: "",
    },
    {
      name: "does not let a mutated retained identity borrow another removed origin",
      preceding: () => withRuntimeImageHistory(ordinaryImage(REPLACEMENT_PNG), OTHER_SOURCE),
      rewrite: (parts) => {
        const replacement = parts[1];
        const retained = parts[2];
        if (!isRecord(replacement) || !isRecord(retained)) {
          throw new Error("Expected two native image parts");
        }
        retained.image_url = replacement.image_url;
        parts.splice(1, 1);
      },
      data: [REPLACEMENT_PNG],
      notes: "",
    },
    {
      name: "retains a saved clone when the original identity changes its image bytes",
      rewrite: (parts) => {
        const original = parts[1];
        if (!isRecord(original)) {
          throw new Error("Expected the native retained image");
        }
        const clone = structuredClone(original);
        original.image_url = `data:image/png;base64,${REPLACEMENT_PNG}`;
        parts.splice(1, 1, original, clone);
      },
      data: [REPLACEMENT_PNG, PNG],
      notes: NOTE,
    },
    {
      name: "consumes a retained occurrence only once when the hook duplicates its clone",
      rewrite: (parts) => {
        const clone = structuredClone(parts[1]);
        parts.splice(1, 1, clone, structuredClone(clone));
      },
      data: [PNG, PNG],
      notes: NOTE,
    },
  ] satisfies Array<{
    name: string;
    preceding?: () => ImageContent;
    rewrite?: (parts: unknown[]) => void;
    data: string[];
    notes: string;
  }>;

  it.each(cases)("$name", async (scenario) => {
    const parts = await captureRequest(fixtures[0], "keep", ordinaryImage(), {
      precedingImages: scenario.preceding ? [scenario.preceding()] : [],
      onPayload: scenario.rewrite,
    });
    expect(parts).toEqual([
      { type: "input_text", text: scenario.notes ? `${QUESTION}\n\n${scenario.notes}` : QUESTION },
      ...scenario.data.map((data) => ({
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${data}`,
      })),
    ]);
  });
});
