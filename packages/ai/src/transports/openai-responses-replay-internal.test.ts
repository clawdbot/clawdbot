import { setImmediate } from "node:timers/promises";
import type { Model } from "@openclaw/llm-core";
import OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenAIResponsesCompactionRejection } from "../provider-options.js";
import type { OpenAIResponsesRequestParams } from "./openai-responses-contracts.js";
import { createResponsesStreamWithEncryptedContentRetry } from "./openai-responses-replay-internal.js";
import { createOpenAIProviderAcceptanceHook } from "./openai-transport-shared.js";
import { withProviderResponseHook } from "./transport-stream-shared.js";

const model = {
  id: "gpt-5.6-luna",
  name: "Responses retry lifecycle",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://responses.example.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-responses">;

describe("Responses streamed recovery lifecycle", () => {
  it.each([
    {
      secondFailure: "streamed",
      expectedOrder: [
        "create:1",
        "hook:req_1",
        "cleanup:req_1",
        "close:req_1",
        "create:2",
        "hook:req_2",
        "close:req_2",
        "create:3",
        "commit",
        "hook:req_3",
        "close:req_3",
      ],
    },
    {
      secondFailure: "HTTP",
      expectedOrder: [
        "create:1",
        "hook:req_1",
        "cleanup:req_1",
        "close:req_1",
        "create:2",
        "create:3",
        "commit",
        "hook:req_3",
        "close:req_3",
      ],
    },
  ])(
    "retains initial metadata and closes prior streams before retry ($secondFailure)",
    async ({ secondFailure, expectedOrder }) => {
      const order: string[] = [];
      const responses: Response[] = [];
      const controller = new AbortController();
      const cleanupStarted = createDeferred();
      const releaseCleanup = createDeferred();
      let consuming: Promise<void> | undefined;
      let attempt = 0;
      const client = new OpenAI({
        apiKey: "fixture-key",
        baseURL: model.baseUrl,
        organization: null,
        project: null,
        maxRetries: 0,
        fetch: async () => {
          const error = {
            code: "invalid_encrypted_content",
            message: "could not decrypt the provided encrypted_content",
            type: "invalid_request_error",
          };
          if (attempt === 2 && secondFailure === "HTTP") {
            const response = Response.json({ error }, { status: 400 });
            responses.push(response);
            return response;
          }
          const response = {
            id: `resp_${attempt}`,
            object: "response",
            model: model.id,
            output: [],
          };
          const events = [
            { type: "response.created", response: { ...response, status: "in_progress" } },
            attempt === 3
              ? { type: "response.completed", response: { ...response, status: "completed" } }
              : { type: "response.failed", response: { ...response, status: "failed", error } },
          ];
          const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
          const httpResponse = new Response(body, {
            headers: { "content-type": "text/event-stream", "x-request-id": `req_${attempt}` },
          });
          responses.push(httpResponse);
          return httpResponse;
        },
      });
      const send = client.responses.create.bind(client.responses);
      const create = vi.spyOn(client.responses, "create").mockImplementation((body, options) => {
        order.push(`create:${++attempt}`);
        return send(body, options);
      });
      const request: OpenAIResponsesRequestParams = {
        model: model.id,
        stream: true,
        input: [
          { type: "reasoning", id: "rs_prior", encrypted_content: "reasoning-data", summary: [] },
          { type: "compaction", id: "cmp_prior", encrypted_content: "compaction-data" },
          { role: "user", content: "After checkpoint" },
        ],
      };
      const buildFullHistoryRequest = vi.fn(
        (): OpenAIResponsesRequestParams => ({
          ...request,
          input: [{ role: "user", content: "Before checkpoint" }, ...request.input],
        }),
      );
      const onCompactionRejected = vi.fn((_checkpoint: OpenAIResponsesCompactionRejection) => {
        order.push("commit");
      });

      try {
        const result = await createResponsesStreamWithEncryptedContentRetry({
          client,
          request,
          requestOptions: { signal: controller.signal },
          model,
          canRetryStream: () => true,
          buildFullHistoryRequest,
          onCompactionRejected,
          wrapStream: ({ stream, response }) => ({
            async *[Symbol.asyncIterator]() {
              try {
                yield* withProviderResponseHook({
                  stream,
                  signal: controller.signal,
                  abort: (reason) => controller.abort(reason),
                  hook: createOpenAIProviderAcceptanceHook(
                    {
                      signal: controller.signal,
                      onResponse: ({ headers }) => {
                        order.push(`hook:${headers["x-request-id"]}`);
                      },
                    },
                    response,
                    model,
                  ),
                });
              } finally {
                if (response === responses[0]) {
                  order.push("cleanup:req_1");
                  cleanupStarted.resolve();
                  await releaseCleanup.promise;
                }
                order.push(`close:${response.headers.get("x-request-id")}`);
              }
            },
          }),
        });
        expect(order).toEqual(["create:1"]);
        expect(result.response).toBe(responses[0]);
        expect(result.response.headers.get("x-request-id")).toBe("req_1");
        expect(result.attempt.kind).toBe("initial");
        expect(result.attempt.request).toBe(request);

        const events: unknown[] = [];
        consuming = (async () => {
          for await (const event of result.stream) {
            events.push(event);
          }
        })();
        await Promise.race([cleanupStarted.promise, consuming]);
        await setImmediate();
        expect(create.mock.calls.length).toBe(1);
        expect(order).toEqual(["create:1", "hook:req_1", "cleanup:req_1"]);
        releaseCleanup.resolve();
        await consuming;

        expect(events).toMatchObject([
          { type: "response.created", response: { id: "resp_1" } },
          ...(secondFailure === "streamed"
            ? [{ type: "response.created", response: { id: "resp_2" } }]
            : []),
          { type: "response.created", response: { id: "resp_3" } },
          { type: "response.completed", response: { id: "resp_3", status: "completed" } },
        ]);
        expect(order).toEqual(expectedOrder);
        expect(create).toHaveBeenCalledTimes(3);
        expect(create.mock.calls[0]?.[0]).toBe(request);
        expect(create.mock.calls[1]?.[0].input).toEqual([
          { type: "reasoning", id: "rs_prior", summary: [] },
          { type: "compaction", id: "cmp_prior", encrypted_content: "compaction-data" },
          { role: "user", content: "After checkpoint" },
        ]);
        expect(create.mock.calls[2]?.[0].input).toEqual([
          { role: "user", content: "Before checkpoint" },
          { type: "reasoning", id: "rs_prior", summary: [] },
          { role: "user", content: "After checkpoint" },
        ]);
        expect(buildFullHistoryRequest).toHaveBeenCalledOnce();
        expect(onCompactionRejected).toHaveBeenCalledExactlyOnceWith({
          id: "cmp_prior",
          data: "compaction-data",
        });
        expect(result.response).toBe(responses[0]);
        expect(result.attempt.kind).toBe("initial");
        expect(result.attempt.request).toBe(request);
      } finally {
        releaseCleanup.resolve();
        controller.abort();
        await Promise.allSettled([consuming]);
        create.mockRestore();
      }
    },
  );
});
