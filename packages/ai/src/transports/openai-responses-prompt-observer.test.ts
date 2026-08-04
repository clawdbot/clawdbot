import type { Context, Model } from "@openclaw/llm-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<"openai" | "azure">,
  errors: [] as Error[],
  order: [] as string[],
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  const createClient = (client: "openai" | "azure") =>
    class MockOpenAI {
      responses = {
        create: (request: Record<string, unknown>) => {
          sdkState.clients.push(client);
          sdkState.order.push(`${client}.create`);
          sdkState.requests.push(request);
          const error = sdkState.errors.shift() ?? new Error("stop after request");
          return {
            withResponse: async () => {
              throw error;
            },
          };
        },
      };
    };
  return { default: createClient("openai"), AzureOpenAI: createClient("azure") };
});

import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

const initialHost = getAiTransportHost();

function createModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "gpt-5.4",
    name: "GPT-5.4",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  } as Model;
}

function createContext(systemPrompt: string, overrides: Partial<Context> = {}): Context {
  return {
    systemPrompt,
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    tools: [],
    ...overrides,
  } as Context;
}

async function runObservedRequest(params: {
  context: Context;
  model?: Model;
  azure?: boolean;
  errors?: Error[];
  options?: Record<string, unknown>;
}) {
  const observations: ResponsesPromptObservation[] = [];
  const options = { apiKey: "test-key", ...params.options };
  const requestStart = sdkState.requests.length;
  const orderStart = sdkState.order.length;
  sdkState.errors = params.errors ?? [new Error("stop after request")];
  responsesPromptObserver.set(options, (observation) => {
    sdkState.order.push("observe");
    observations.push(observation);
  });
  const streamFn = params.azure
    ? createAzureOpenAIResponsesTransportStreamFn()
    : createOpenAIResponsesTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(params.model ?? createModel(), params.context, options as never),
  );
  expect((await stream.result()).stopReason).toBe("error");
  return {
    observations,
    order: sdkState.order.slice(orderStart),
    requests: sdkState.requests.slice(requestStart),
  };
}

beforeEach(() => {
  sdkState.clients = [];
  sdkState.errors = [];
  sdkState.order = [];
  sdkState.requests = [];
  configureAiTransportHost(initialHost);
});

afterAll(() => {
  configureAiTransportHost(initialHost);
});

describe("OpenAI Responses provider prompt observer", () => {
  it.each([
    { reasoning: true, promptSource: "input.developer" },
    { reasoning: false, promptSource: "input.system" },
  ] as const)("observes the final $promptSource prompt", async ({ reasoning, promptSource }) => {
    const prompt = `PRIVATE-${promptSource}-PROMPT`;
    const run = await runObservedRequest({
      context: createContext(prompt),
      model: createModel({ reasoning }),
    });

    expect(run.observations).toEqual([
      {
        applicationAttempt: "initial",
        promptSource,
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(run.observations)).not.toContain(prompt);
  });

  it("observes native Codex instructions", async () => {
    const prompt = "PRIVATE-NATIVE-INSTRUCTIONS";
    const run = await runObservedRequest({
      context: createContext(prompt),
      model: createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    });

    expect(run.requests[0]?.instructions).toBe(prompt);
    expect(run.observations[0]).toEqual({
      applicationAttempt: "initial",
      promptSource: "instructions",
      expectedChars: prompt.length,
      observedChars: prompt.length,
      matchesAssembledPrompt: true,
    });
  });

  it("observes Azure Responses egress", async () => {
    const prompt = "PRIVATE-AZURE-PROMPT";
    const run = await runObservedRequest({
      azure: true,
      context: createContext(prompt),
      model: createModel({
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com",
      }),
    });

    expect(sdkState.clients).toEqual(["azure"]);
    expect(run.order).toEqual(["observe", "azure.create"]);
    expect(run.observations[0]).toMatchObject({
      applicationAttempt: "initial",
      promptSource: "input.developer",
      matchesAssembledPrompt: true,
    });
  });

  it("observes the async replacement immediately before final transformed egress", async () => {
    const prompt = "PRIVATE-FINAL-TRANSFORMED-PROMPT";
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: () => ({ metadata: { host: "added" } }),
      },
    });
    const run = await runObservedRequest({
      context: createContext(prompt, { tools: [tool("exec"), tool("wait")] as never }),
      options: {
        openclawCodeModeToolSurface: true,
        onPayload: async () => {
          await Promise.resolve();
          return {
            model: "gpt-5.4",
            stream: true,
            metadata: { caller: "kept" },
            input: [
              { type: "message", role: "developer", content: prompt },
              {
                type: "message",
                role: "user",
                content: [{ type: "input_image", image_url: "data:image/png;base64,invalid!" }],
              },
            ],
            tools: [tool("exec"), tool("wait"), tool("rogue")],
          };
        },
      },
    });

    expect(run.order).toEqual(["observe", "openai.create"]);
    expect(run.observations[0]?.matchesAssembledPrompt).toBe(true);
    expect(run.requests[0]?.metadata).toEqual({ caller: "kept", host: "added" });
    expect(run.requests[0]?.tools).toEqual([tool("exec"), tool("wait")]);
    expect(JSON.stringify(run.requests[0]?.input)).toContain("omitted image payload");
  });

  it("observes initial and encrypted-content retry application attempts", async () => {
    const prompt = "PRIVATE-REPLAY-PROMPT";
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const run = await runObservedRequest({
      context: createContext(prompt),
      errors: [invalidEncryptedContent, new Error("stop after retry")],
      options: {
        onPayload: (request: Record<string, unknown>) => ({
          ...request,
          input: [
            ...((request.input as unknown[]) ?? []),
            { type: "reasoning", encrypted_content: "opaque", summary: [] },
          ],
        }),
      },
    });

    expect(run.order).toEqual(["observe", "openai.create", "observe", "openai.create"]);
    expect(run.observations.map((entry) => entry.applicationAttempt)).toEqual([
      "initial",
      "encrypted-content-retry",
    ]);
    expect(run.observations.every((entry) => entry.matchesAssembledPrompt)).toBe(true);
    expect(JSON.stringify(run.requests[0])).toContain("encrypted_content");
    expect(JSON.stringify(run.requests[1])).not.toContain("encrypted_content");
  });

  it("uses cache-boundary and surrogate normalization as the expected prompt owner", async () => {
    const systemPrompt = `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\ud800`;
    const normalizedPrompt = "stable\ndynamic";
    const run = await runObservedRequest({ context: createContext(systemPrompt) });

    expect(run.observations[0]).toMatchObject({
      expectedChars: normalizedPrompt.length,
      observedChars: normalizedPrompt.length,
      matchesAssembledPrompt: true,
    });
    const request = run.requests[0];
    if (!request) {
      throw new Error("missing captured request");
    }
    expect((request.input as Array<Record<string, unknown>>)[0]).toMatchObject({
      content: [{ type: "input_text", text: normalizedPrompt }],
    });
  });

  it("reports missing and same-length mutated prompts without retaining content", async () => {
    const missingPrompt = "PRIVATE-MISSING-PROMPT";
    const missing = await runObservedRequest({
      context: createContext(missingPrompt),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      },
    });
    const mismatch = await runObservedRequest({
      context: createContext("trusted"),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "developer", content: "altered" }],
        }),
      },
    });

    expect(missing.observations[0]).toMatchObject({
      promptSource: "missing",
      observedChars: 0,
      matchesAssembledPrompt: false,
    });
    expect(mismatch.observations[0]).toMatchObject({
      promptSource: "input.developer",
      expectedChars: 7,
      observedChars: 7,
      matchesAssembledPrompt: false,
    });
    expect(JSON.stringify([...missing.observations, ...mismatch.observations])).not.toContain(
      missingPrompt,
    );
  });
});
