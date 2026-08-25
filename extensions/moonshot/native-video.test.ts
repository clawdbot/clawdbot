import { createServer } from "node:http";
import { createOpenAICompletionsTransportStreamFn } from "@openclaw/ai/transports";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderContext,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { wrapMoonshotStream } from "./native-video.js";
import { MOONSHOT_BASE_URL } from "./provider-catalog.js";

const MP4_A = "data:video/mp4;base64,YWFhYWFhYWFhYWFhYWFhYQ==";
const MP4_B = "data:video/mp4;base64,YmJiYmJiYmJiYmJiYmJiYg==";
const WEBM = "data:video/webm;base64,d2VibQ==";

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "kimi-k3",
    name: "Kimi K3",
    provider: "moonshot",
    api: "openai-completions",
    baseUrl: MOONSHOT_BASE_URL,
    reasoning: true,
    input: ["text", "image", "video"] as never,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 1_048_576,
    ...overrides,
  } as Model;
}

function genericPayload(videoUrls = [MP4_A]) {
  return {
    model: "kimi-k3",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "before" },
          { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
          ...videoUrls.map((url) => ({ type: "video_url", video_url: { url } })),
          { type: "text", text: "after" },
        ],
      },
    ],
  };
}

function capturePayloadStream(payload: unknown, capture: (value: unknown) => void): StreamFn {
  return async (payloadModel, _context, options) => {
    const replacement = await options?.onPayload?.(payload, payloadModel);
    capture(replacement === undefined ? payload : replacement);
    return createAssistantMessageEventStream();
  };
}

function createNativeWrapper(streamFn: StreamFn, requestBytesExclusive = 100_000_000): StreamFn {
  return wrapMoonshotStream(
    { provider: "moonshot", modelId: "kimi-k3", streamFn } as never,
    false,
    requestBytesExclusive,
  );
}

describe("Moonshot native video wrapper", () => {
  it("preserves serialized current-user MP4 parts and order", async () => {
    const payload = genericPayload();
    let dispatched: unknown;
    const caller = vi.fn((value: unknown) => {
      expect(JSON.stringify(value)).not.toContain("__openclaw");
      expect(JSON.stringify(value)).not.toContain("/private/");
      expect((value as typeof payload).messages[0]?.content.map((part) => part.type)).toEqual([
        "text",
        "image_url",
        "video_url",
        "text",
      ]);
    });
    const wrapped = createNativeWrapper(
      capturePayloadStream(payload, (value) => (dispatched = value)),
    );

    await wrapped(model(), { messages: [] } as Context, { onPayload: caller });

    expect(caller).toHaveBeenCalledOnce();
    expect((dispatched as typeof payload).messages[0]?.content[2]).toEqual({
      type: "video_url",
      video_url: { url: MP4_A },
    });
  });

  it("allows valid hook clones and injections while omitting non-MP4 video", async () => {
    const payload = genericPayload([MP4_A, WEBM]);
    let dispatched: unknown;
    const wrapped = createNativeWrapper(
      capturePayloadStream(payload, (value) => (dispatched = value)),
    );

    await wrapped(model(), { messages: [] } as Context, {
      onPayload(value) {
        const content = (value as typeof payload).messages[0]!.content;
        const valid = content[2]! as Record<string, unknown>;
        content.push(structuredClone(valid) as never);
        content.push({ type: "video_url", video_url: { url: MP4_B } } as never);
        content.push({ type: "image_url", image_url: { url: WEBM } } as never);
      },
    });

    const body = JSON.stringify(dispatched);
    expect(body.split(MP4_A)).toHaveLength(3);
    expect(body).toContain("YmJiYmJi");
    expect(body).not.toContain("d2VibQ");
    expect(body.match(/video omitted/gu)).toHaveLength(2);
  });

  it("validates a caller replacement after Moonshot thinking post-processing", async () => {
    const payload = genericPayload();
    let dispatched: unknown;
    const wrapped = createNativeWrapper(
      capturePayloadStream(payload, (value) => (dispatched = value)),
    );

    await wrapped(model(), { messages: [] } as Context, {
      onPayload(value) {
        return structuredClone(value);
      },
    });

    expect(dispatched).toMatchObject({ reasoning_effort: "max" });
    expect((dispatched as typeof payload).messages[0]!.content[2]).toEqual({
      type: "video_url",
      video_url: { url: MP4_A },
    });
  });

  it("evicts later admitted videos in place to satisfy the exclusive final size", async () => {
    const payload = genericPayload([MP4_A, MP4_B]);
    const projectedWithSecondOmitted = genericPayload([MP4_A]);
    projectedWithSecondOmitted.messages[0]!.content.splice(3, 0, {
      type: "text",
      text: "(video omitted: Moonshot request size limit)",
    } as never);
    Object.assign(projectedWithSecondOmitted, { reasoning_effort: "max" });
    const ceiling = Buffer.byteLength(JSON.stringify(projectedWithSecondOmitted), "utf8") + 1;
    let dispatched: unknown;
    const wrapped = createNativeWrapper(
      capturePayloadStream(payload, (value) => (dispatched = value)),
      ceiling,
    );

    await wrapped(model(), { messages: [] } as Context, {});

    const content = (dispatched as typeof payload).messages[0]!.content;
    expect(content[2]).toEqual({ type: "video_url", video_url: { url: MP4_A } });
    expect(content[3]).toMatchObject({ type: "text", text: expect.stringContaining("size limit") });
    expect(Buffer.byteLength(JSON.stringify(dispatched), "utf8")).toBeLessThan(ceiling);
  });

  it("measures caller replacements and rejects an oversized non-video body", async () => {
    const wrapped = createNativeWrapper(
      capturePayloadStream(genericPayload(), () => undefined),
      200,
    );

    await expect(
      wrapped(model(), { messages: [] } as Context, {
        onPayload: () => ({ model: "kimi-k3", messages: [], padding: "x".repeat(300) }),
      }),
    ).rejects.toThrow("Moonshot request body must be smaller than 200 bytes");
  });

  it.each(["wrapStreamFn", "wrapSimpleCompletionStreamFn"] as const)(
    "keeps thinking outside native video for %s",
    async (hookName) => {
      const provider = await registerSingleProviderPlugin(plugin);
      const payload = genericPayload();
      let dispatched: unknown;
      const wrapped = provider[hookName]?.({
        provider: "moonshot",
        modelId: "kimi-k3",
        thinkingLevel: "off",
        streamFn: capturePayloadStream(payload, (value) => (dispatched = value)),
      } as never);
      if (!wrapped) {
        throw new Error(`Moonshot did not register ${hookName}`);
      }

      await wrapped(model(), { messages: [] } as Context, {
        onPayload(value) {
          const record = value as Record<string, unknown>;
          expect(record.reasoning_effort).toBe("max");
          expect(JSON.stringify(record)).toContain('"type":"video_url"');
          record.reasoning_effort = "low";
        },
      });

      expect(dispatched).toMatchObject({ reasoning_effort: "max" });
    },
  );
});

describe("Moonshot registered transport boundary", () => {
  it("sends ordered video_url content through the real Chat Completions transport", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("missing loopback address");
      }
      const provider = await registerSingleProviderPlugin(plugin);
      const officialModel = model();
      const normalized = provider.normalizeResolvedModel?.({
        provider: "moonshot",
        modelId: "kimi-k3",
        model: officialModel,
      } as never) as Model | undefined;
      expect(normalized?.input).toContain("video");
      const transport = createOpenAICompletionsTransportStreamFn();
      const loopbackTransport: StreamFn = (runtimeModel, context, options) =>
        transport(
          attachModelProviderRequestTransport(
            {
              ...runtimeModel,
              provider: "custom",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
            },
            { allowPrivateNetwork: true },
          ),
          context,
          options,
        );
      const wrapped = provider.wrapStreamFn?.({
        provider: "moonshot",
        modelId: "kimi-k3",
        thinkingLevel: "off",
        streamFn: loopbackTransport,
      } as never);
      if (!wrapped || !normalized) {
        throw new Error("Moonshot registered transport unavailable");
      }
      const context: ProviderContext = {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
              { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
              { type: "text", text: "after" },
            ],
            timestamp: 1,
          },
        ],
      };
      let callerPayload: unknown;
      const caller = vi.fn((payload: unknown) => (callerPayload = payload));
      const stream = await wrapped(normalized, context as never, {
        apiKey: "test-key",
        maxRetries: 0,
        onPayload: caller,
      });
      let streamError: unknown;
      for await (const event of stream) {
        if (event.type === "error") {
          streamError = event.error;
        }
      }

      expect(caller, JSON.stringify(streamError)).toHaveBeenCalledOnce();
      expect(JSON.stringify(callerPayload)).not.toContain("/private/");
      expect(JSON.stringify(callerPayload)).toContain("data:video/mp4;base64,dmlkZW8=");
      expect(requestBody, JSON.stringify(streamError)).toBeDefined();
      const messages = requestBody?.messages as Array<{ content?: Array<Record<string, unknown>> }>;
      expect(messages[0]?.content).toEqual([
        { type: "text", text: "before" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
        { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8=" } },
        { type: "text", text: "after" },
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });
});
