import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import { readRuntimeImageHistory } from "@openclaw/media-core";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { resolveCurrentTurnImages } from "../../../auto-reply/reply/current-turn-images.js";
import type { RuntimeMsgContext } from "../../../auto-reply/templating.js";
import { readRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { withTestDir } from "../../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { createExtensionRuntime } from "../../sessions/extensions/loader.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { createAgentSession } from "../../sessions/sdk.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import { prepareEmbeddedAttemptPromptExecution } from "./prompt-image-preparation.js";

const HISTORY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
// Complete 1x1, 24-bit BI_RGB bitmap: 14-byte file header, 40-byte DIB, padded BGR row.
const HISTORY_BMP = Buffer.from(
  "Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAAAAD/AA==",
  "base64",
);
const QUESTION = "What was in the retained photo?";
const NOW = 1_800_000_000_000;
const MODEL_ID = "retained-image-model";
const HISTORY_NOTE =
  `[Recent image 1 from Ada, message retained-H, sent at ${new Date(NOW - 1_000).toISOString()}, ` +
  "message 1 of 1 in available history, attached as media.]";
const IMAGE_OMISSION = "[omitted image payload: invalid inline image data]";

function imageHash(image: { data: string }): string {
  return createHash("sha256").update(Buffer.from(image.data, "base64")).digest("hex");
}

function requestContent(payload: unknown, expectedUserCount = 1): Record<string, unknown>[] {
  const request = asNonArrayRecord(payload);
  expect(request).toMatchObject({ model: MODEL_ID, stream: true });
  const input = request.input;
  if (!Array.isArray(input)) {
    throw new Error("Responses request is missing its input array");
  }
  const users = input.filter((entry) => asNonArrayRecord(entry).role === "user");
  expect(users).toHaveLength(expectedUserCount);
  const message = asNonArrayRecord(users.at(-1));
  expect(message).toMatchObject({ type: "message", role: "user" });
  const content = message.content;
  if (!Array.isArray(content)) {
    throw new Error("Responses user input is missing its content array");
  }
  return content.map((part) => asNonArrayRecord(part));
}

function wireImageHashes(parts: Record<string, unknown>[]): string[] {
  return parts
    .filter((part) => part.type === "input_image")
    .map((part) => {
      if (typeof part.image_url !== "string" || !part.image_url.includes(";base64,")) {
        throw new Error("Responses image is not an inline base64 data URL");
      }
      return imageHash({ data: part.image_url.slice(part.image_url.indexOf(",") + 1) });
    });
}

function responseBody(requestIndex: number): { created: string; completed: string } {
  const suffix = requestIndex === 1 ? "" : `_${requestIndex}`;
  const response = {
    id: `resp_retained_image${suffix}`,
    object: "response",
    status: "completed",
    model: MODEL_ID,
    output: [
      {
        id: `msg_retained_image${suffix}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Synthetic request received.", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  return {
    created: `data: ${JSON.stringify({
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    })}\n\n`,
    completed: `data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
  };
}

async function resolveRetainedImages(
  base: string,
  fixture: { extension: string; mimeType: string; bytes: Buffer; sha256: string },
) {
  const historyPath = path.join(base, "media", "inbound", `history.${fixture.extension}`);
  await fs.mkdir(path.dirname(historyPath), { recursive: true });
  await fs.writeFile(historyPath, fixture.bytes);
  const ctx: RuntimeMsgContext = {
    Body: QUESTION,
    Timestamp: NOW,
    InboundHistory: [
      {
        sender: "Ada",
        body: "A retained photo.",
        timestamp: NOW - 1_000,
        messageId: "retained-H",
        media: [{ path: historyPath, contentType: fixture.mimeType, kind: "image" }],
      },
    ],
  };
  const images = await resolveCurrentTurnImages({ ctx, cfg: {} });
  expect(images.images?.map(imageHash)).toEqual([fixture.sha256]);
  expect(images.images?.map((image) => image.mimeType)).toEqual([fixture.mimeType]);
  expect(images.images?.map(readRuntimeImageHistory)).toEqual([
    {
      key: `retained-H\0${historyPath}`,
      sourceText:
        `from Ada, message retained-H, sent at ${new Date(NOW - 1_000).toISOString()}, ` +
        "message 1 of 1 in available history",
    },
  ]);
  return images;
}

type ResponsesFixture = {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  model: ReturnType<typeof makeProviderModelFixture>;
  requests: Array<{ method?: string; path?: string; body: string }>;
  beforeSanitization: unknown[];
  releaseFirstResponse: () => void;
};

async function withResponsesSession(
  base: string,
  options: { input: Array<"text" | "image">; blocked?: boolean; holdFirstResponse?: boolean },
  run: (fixture: ResponsesFixture) => Promise<void>,
): Promise<void> {
  const requests: ResponsesFixture["requests"] = [];
  const beforeSanitization: unknown[] = [];
  let heldResponse: (() => void) | undefined;
  const releaseFirstResponse = () => {
    heldResponse?.();
    heldResponse = undefined;
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const body = responseBody(requests.length);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(body.created);
      if (options.holdFirstResponse && requests.length === 1) {
        heldResponse = () => response.end(body.completed);
      } else {
        response.end(body.completed);
      }
    });
  });
  const previousHost = getAiTransportHost();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Responses fixture has no loopback address");
    }
    // Existing transport host seam; the real SDK sends HTTP only to this fixture.
    configureAiTransportHost({ buildModelFetch: () => globalThis.fetch });
    const model = makeProviderModelFixture({
      id: MODEL_ID,
      provider: "retained-image-fixture",
      api: "openai-responses",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      input: options.input,
    });
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(model.provider, "synthetic-loopback-only");
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const transport = createOpenAIResponsesTransportStreamFn();
    modelRegistry.registerProvider(model.provider, {
      api: "openai-responses",
      streamSimple: (runtimeModel, context, streamOptions) =>
        transport(runtimeModel, context, {
          ...streamOptions,
          onPayload: async (payload, selectedModel) => {
            const modified = await streamOptions?.onPayload?.(payload, selectedModel);
            beforeSanitization.push(structuredClone(modified ?? payload));
            return modified;
          },
        }),
    });
    const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
    const { session } = await createAgentSession({
      cwd: base,
      agentDir: base,
      authStorage,
      modelRegistry,
      model,
      noTools: "all",
      sessionManager: SessionManager.inMemory(base),
      settingsManager: SettingsManager.inMemory({
        images: { blockImages: options.blocked ?? false },
        compaction: { enabled: false },
        retry: { enabled: false, provider: { timeoutMs: 1_000, maxRetries: 0 } },
      }),
      resourceLoader: {
        getExtensions: () => extensions,
        getSkills: () => ({ skills: [], diagnostics: [] }),
        getPrompts: () => ({ prompts: [], diagnostics: [] }),
        getThemes: () => ({ themes: [], diagnostics: [] }),
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSystemPrompt: () => "",
        getAppendSystemPrompt: () => [],
        extendResources: () => {},
        reload: async () => {},
      },
    });
    try {
      await run({ session, model, requests, beforeSanitization, releaseFirstResponse });
    } finally {
      releaseFirstResponse();
      await session.abort();
      session.dispose();
    }
  } finally {
    configureAiTransportHost(previousHost);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("retained image provenance at Responses HTTP egress", () => {
  it.each([
    {
      format: "PNG",
      extension: "png",
      mimeType: "image/png",
      bytes: HISTORY_PNG,
      sha256: "b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640",
      vision: true,
      sanitized: true,
      blocked: false,
      forwarded: true,
    },
    {
      format: "BMP",
      extension: "bmp",
      mimeType: "image/bmp",
      bytes: HISTORY_BMP,
      sha256: "f7cbd816abfb19030d23b8de5435d0141443665a81ed5ba12114c70b5f53b610",
      vision: true,
      sanitized: true,
      blocked: false,
      forwarded: false,
    },
    {
      format: "PNG on a text-only model",
      extension: "png",
      mimeType: "image/png",
      bytes: HISTORY_PNG,
      sha256: "b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640",
      vision: false,
      sanitized: false,
      blocked: false,
      forwarded: false,
    },
    {
      format: "truncated PNG",
      extension: "png",
      mimeType: "image/png",
      bytes: HISTORY_PNG.subarray(0, 8),
      sha256: createHash("sha256").update(HISTORY_PNG.subarray(0, 8)).digest("hex"),
      vision: true,
      sanitized: false,
      blocked: false,
      forwarded: false,
    },
    {
      format: "PNG with image reading disabled",
      extension: "png",
      mimeType: "image/png",
      bytes: HISTORY_PNG,
      sha256: "b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640",
      vision: true,
      sanitized: true,
      blocked: true,
      forwarded: false,
    },
  ])(
    "matches final input for retained $format",
    async ({ extension, mimeType, bytes, sha256, vision, sanitized, blocked, forwarded }) => {
      await withTestDir({ prefix: "openclaw-retained-image-responses-" }, async (base) => {
        await withEnvAsync({ OPENCLAW_STATE_DIR: base }, async () => {
          const images = await resolveRetainedImages(base, { extension, mimeType, bytes, sha256 });
          const modelInput: Array<"text" | "image"> = vision ? ["text", "image"] : ["text"];
          const prepared = await prepareEmbeddedAttemptPromptExecution({
            attempt: {
              config: {},
              model: { input: modelInput },
              images: images.images,
              imageOrder: images.imageOrder,
            },
            mediaOwnerAgentId: "main",
            effectiveFsWorkspaceOnly: false,
            effectiveWorkspace: base,
            prompt: QUESTION,
            skipPromptSubmission: false,
          });
          expect(prepared.images.map(imageHash)).toEqual(sanitized ? [sha256] : []);
          expect(prepared.images.map((image) => image.mimeType)).toEqual(
            sanitized ? [mimeType] : [],
          );
          expect(prepared.failedMediaCount).toBe(0);

          await withResponsesSession(base, { input: modelInput, blocked }, async (fixture) => {
            const { session, requests, beforeSanitization } = fixture;
            await session.prompt(QUESTION, { images: prepared.images });
            expect(session.getLastAssistantText()).toBe("Synthetic request received.");
            expect(session.agent.state.messages.at(-1)).toMatchObject({
              role: "assistant",
              stopReason: "stop",
            });
            const canonicalUser = session.agent.state.messages.find(
              (entry) => entry.role === "user",
            );
            expect(JSON.stringify(canonicalUser)).not.toContain("attached as media");
            expect(beforeSanitization).toHaveLength(1);
            const before = requestContent(beforeSanitization[0]);
            expect(before.map((part) => part.type)).toEqual(
              blocked
                ? ["input_text", "input_text"]
                : sanitized
                  ? ["input_text", "input_image"]
                  : ["input_text"],
            );
            expect(wireImageHashes(before)).toEqual(sanitized && !blocked ? [sha256] : []);
            const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
            expect(
              before.filter((part) => part.type === "input_image").map((part) => part.image_url),
            ).toEqual(sanitized && !blocked ? [dataUrl] : []);
            expect(requests.map(({ method, path: requestPath }) => [method, requestPath])).toEqual([
              ["POST", "/v1/responses"],
            ]);
            const wire = requestContent(JSON.parse(requests[0]!.body) as unknown);
            expect(wire.map((part) => part.type)).toEqual(
              forwarded
                ? ["input_text", "input_image"]
                : sanitized
                  ? ["input_text", "input_text"]
                  : ["input_text"],
            );
            expect(wireImageHashes(wire)).toEqual(forwarded ? [sha256] : []);
            expect(
              wire.filter((part) => part.type === "input_image").map((part) => part.image_url),
            ).toEqual(forwarded ? [dataUrl] : []);
            const wireText = wire
              .filter((part) => part.type === "input_text")
              .map((part) => part.text);
            expect(wireText.filter((text) => text === IMAGE_OMISSION)).toEqual(
              sanitized && !blocked && !forwarded ? [IMAGE_OMISSION] : [],
            );
            expect(wireText).toEqual(
              forwarded
                ? [`${QUESTION}\n\n${HISTORY_NOTE}`]
                : blocked
                  ? [QUESTION, "Image reading is disabled."]
                  : sanitized
                    ? [QUESTION, IMAGE_OMISSION]
                    : [QUESTION],
            );
          });
        });
      });
    },
  );

  it.each([
    {
      format: "PNG",
      bytes: HISTORY_PNG,
      sha256: "b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640",
      forwarded: true,
    },
    {
      format: "truncated PNG",
      bytes: HISTORY_PNG.subarray(0, 8),
      sha256: createHash("sha256").update(HISTORY_PNG.subarray(0, 8)).digest("hex"),
      forwarded: false,
    },
  ])(
    "consumes retained $format through accepted steering",
    async ({ bytes, sha256, forwarded }) => {
      await withTestDir({ prefix: "openclaw-retained-image-steer-" }, async (base) => {
        await withEnvAsync({ OPENCLAW_STATE_DIR: base }, async () => {
          const images = await resolveRetainedImages(base, {
            extension: "png",
            mimeType: "image/png",
            bytes,
            sha256,
          });
          await withResponsesSession(
            base,
            { input: ["text", "image"], holdFirstResponse: true },
            async ({ session, model, requests, beforeSanitization, releaseFirstResponse }) => {
              // The embedded attempt installs this transform before queued input reaches the model.
              const restoreTransform = installHistoryImagePruneContextTransform(session.agent, {
                workspaceDir: base,
                model,
                maxBytes: MAX_IMAGE_BYTES,
                maxDimensionPx: resolveImageSanitizationLimits({}).maxDimensionPx,
                workspaceOnly: true,
              });
              const admissions: Array<{
                imageHashes: string[];
                hasCurrentMediaFacts: boolean;
                pendingSteers: readonly string[];
              }> = [];
              const unsubscribe = session.subscribe((event) => {
                if (
                  event.type === "message_start" &&
                  event.message.role === "user" &&
                  Array.isArray(event.message.content) &&
                  event.message.content.some(
                    (part) => part.type === "text" && part.text === QUESTION,
                  )
                ) {
                  admissions.push({
                    imageHashes: event.message.content
                      .filter((part) => part.type === "image")
                      .map(imageHash),
                    hasCurrentMediaFacts: readRuntimePromptMediaFacts(event.message) !== undefined,
                    pendingSteers: [...session.getSteeringMessages()],
                  });
                }
              });
              try {
                const initialPrompt = "Start the image follow-up.";
                const running = session.prompt(initialPrompt);
                await vi.waitFor(() => expect(requests).toHaveLength(1));
                expect(session.isStreaming).toBe(true);
                expect(requestContent(JSON.parse(requests[0]!.body) as unknown)).toEqual([
                  { type: "input_text", text: initialPrompt },
                ]);

                // Raw resolver images bypass initial-prompt preparation, as production steer does.
                await session.steer(QUESTION, images.images);
                expect(session.getSteeringMessages()).toEqual([QUESTION]);
                expect(session.pendingMessageCount).toBe(1);
                expect(admissions).toEqual([]);
                expect(requests).toHaveLength(1);
                releaseFirstResponse();
                await running;

                expect(admissions).toEqual([
                  { imageHashes: [sha256], hasCurrentMediaFacts: false, pendingSteers: [] },
                ]);
                expect(session.pendingMessageCount).toBe(0);
                expect(session.getSteeringMessages()).toEqual([]);
                expect(session.getLastAssistantText()).toBe("Synthetic request received.");
                expect(session.agent.state.messages.at(-1)).toMatchObject({
                  role: "assistant",
                  stopReason: "stop",
                });
                const canonicalUsers = session.agent.state.messages.filter(
                  (entry) => entry.role === "user",
                );
                expect(canonicalUsers).toHaveLength(2);
                expect(canonicalUsers[1]?.content).toEqual([
                  { type: "text", text: QUESTION },
                  ...images.images!,
                ]);
                expect(JSON.stringify(canonicalUsers)).not.toContain("attached as media");

                expect(beforeSanitization).toHaveLength(2);
                expect(requestContent(beforeSanitization[0])).toEqual([
                  { type: "input_text", text: initialPrompt },
                ]);
                const before = requestContent(beforeSanitization[1], 2);
                expect(before.map((part) => part.type)).toEqual(
                  forwarded ? ["input_text", "input_image"] : ["input_text"],
                );
                expect(wireImageHashes(before)).toEqual(forwarded ? [sha256] : []);
                expect(
                  before.filter((part) => part.type === "input_text").map((part) => part.text),
                ).toEqual([QUESTION]);
                expect(
                  requests.map(({ method, path: requestPath }) => [method, requestPath]),
                ).toEqual([
                  ["POST", "/v1/responses"],
                  ["POST", "/v1/responses"],
                ]);
                const wire = requestContent(JSON.parse(requests[1]!.body) as unknown, 2);
                expect(wire.map((part) => part.type)).toEqual(
                  forwarded ? ["input_text", "input_image"] : ["input_text"],
                );
                expect(wireImageHashes(wire)).toEqual(forwarded ? [sha256] : []);
                expect(
                  wire.filter((part) => part.type === "input_image").map((part) => part.image_url),
                ).toEqual(forwarded ? [`data:image/png;base64,${bytes.toString("base64")}`] : []);
                expect(
                  wire.filter((part) => part.type === "input_text").map((part) => part.text),
                ).toEqual(forwarded ? [`${QUESTION}\n\n${HISTORY_NOTE}`] : [QUESTION]);
              } finally {
                releaseFirstResponse();
                await session.abort();
                unsubscribe();
                restoreTransform();
              }
            },
          );
        });
      });
    },
  );
});
