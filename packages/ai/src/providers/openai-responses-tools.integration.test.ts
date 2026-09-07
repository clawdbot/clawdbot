import { expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { createLlmRuntime } from "../stream.js";
import { createOpenAIResponsesTransportStreamFn } from "../transports/openai-responses-client.js";
import {
  createResponsesLoopbackServer,
  responsesLoopbackModel,
} from "../transports/openai-responses-loopback.test-support.js";
import type { Context, Tool } from "../types.js";
import { registerBuiltInApiProviders } from "./register-builtins.js";

function completedResponseEvents() {
  return [
    {
      type: "response.completed",
      response: {
        id: "resp_tools",
        status: "completed",
        output: [
          {
            type: "message",
            id: "msg_tools",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "done", annotations: [] }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
}

it.each(
  (["provider", "transport"] as const).flatMap((entrypoint) =>
    [true, false, undefined].map((strict) => ({ entrypoint, strict })),
  ),
)("serializes $entrypoint Responses tools with strict=$strict", async ({ entrypoint, strict }) => {
  const server = await createResponsesLoopbackServer(completedResponseEvents);
  configureAiTransportHost({ resolveOpenAIStrictToolSetting: () => strict });
  const parameters = Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    required: Object.freeze([]),
    additionalProperties: false,
  });
  let descriptionReads = 0;
  const tools: Tool[] = [
    { name: "zeta", description: "Last", parameters },
    {
      name: "alpha",
      get description(): string {
        descriptionReads += 1;
        throw new Error("Optional description is unavailable");
      },
      parameters,
    },
  ];
  const context: Context = {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools,
  };
  const expectedTools = [
    { type: "function", name: "alpha", parameters, ...(strict !== undefined ? { strict } : {}) },
    {
      type: "function",
      name: "zeta",
      description: "Last",
      parameters,
      ...(strict !== undefined ? { strict } : {}),
    },
  ];
  const lifecycle: string[] = [];
  const options = {
    apiKey: "synthetic-key",
    cacheRetention: "none" as const,
    transport: "sse" as const,
    onPayload: () => {
      lifecycle.push("payload");
    },
    onResponse: () => {
      lifecycle.push("response");
    },
  };
  try {
    const runtime = createLlmRuntime();
    registerBuiltInApiProviders(runtime.registry);
    const stream =
      entrypoint === "provider"
        ? runtime.stream(responsesLoopbackModel, context, options)
        : await createOpenAIResponsesTransportStreamFn()(responsesLoopbackModel, context, options);
    for await (const event of stream) {
      if (event.type === "start" || event.type === "done" || event.type === "error") {
        lifecycle.push(event.type);
      }
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([expect.objectContaining({ type: "text", text: "done" })]);
    expect(result.usage).toMatchObject({ input: 5, output: 3, totalTokens: 8 });
    expect(lifecycle).toEqual(["payload", "response", "start", "done"]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.tools).toEqual(expectedTools);
    expect(server.rawRequests[0]).toContain(`"tools":${JSON.stringify(expectedTools)}`);
    expect(descriptionReads).toBe(1);
    expect(tools.map((tool) => tool.name)).toEqual(["zeta", "alpha"]);
    expect(tools.every((tool) => tool.parameters === parameters)).toBe(true);
  } finally {
    configureAiTransportHost({});
    await server.close();
  }
});

it("reports one strict downgrade across Responses entrypoints without changing the wire schema", async () => {
  const server = await createResponsesLoopbackServer(completedResponseEvents);
  const diagnostics: Array<{ subsystem: string; message: string; data?: unknown }> = [];
  configureAiTransportHost({
    resolveOpenAIStrictToolSetting: () => true,
    logDebug: (subsystem, build) => {
      const entry = build();
      if (entry?.message.includes("strict mode downgraded")) {
        diagnostics.push({ subsystem, ...entry });
      }
    },
  });
  const model = { ...responsesLoopbackModel, id: "strict-diagnostic-loopback" };
  const parameters = {
    type: "object",
    properties: { value: { type: "integer" } },
    required: [],
    additionalProperties: false,
  };
  const context: Context = {
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [{ name: "record_value", description: "Record", parameters }],
  };
  const options = { apiKey: "synthetic-key", cacheRetention: "none" as const };
  try {
    const runtime = createLlmRuntime();
    registerBuiltInApiProviders(runtime.registry);
    for (const stream of [
      () => runtime.stream(model, context, options),
      () => createOpenAIResponsesTransportStreamFn()(model, context, options),
    ]) {
      expect((await (await stream()).result()).stopReason).toBe("stop");
    }
    expect(server.requests.map((request) => request.tools)).toEqual(
      Array.from({ length: 2 }, () => [
        {
          type: "function",
          name: "record_value",
          description: "Record",
          parameters,
          strict: false,
        },
      ]),
    );
    expect(diagnostics).toEqual([
      {
        subsystem: "openai-transport",
        message: expect.stringContaining("OpenAI responses tool schema strict mode downgraded"),
        data: expect.objectContaining({
          transport: "responses",
          provider: model.provider,
          model: model.id,
          incompatibleToolCount: 1,
          sample: [expect.objectContaining({ tool: "record_value" })],
        }),
      },
    ]);
  } finally {
    configureAiTransportHost({});
    await server.close();
  }
});
