import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const mocks = vi.hoisted(() => ({
  prepareSimpleCompletionModelForAgent: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../../agents/simple-completion-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/simple-completion-runtime.js")>()),
  prepareSimpleCompletionModelForAgent: mocks.prepareSimpleCompletionModelForAgent,
  resolveSimpleCompletionSelectionForAgent: mocks.resolveSimpleCompletionSelectionForAgent,
}));

const modelId = "gpt-5.6-luna";
const responseModel = "gpt-5.6-luna-2026-08-01";
const authToken = (() => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-runtime-model-test" },
    }),
  ).toString("base64url");
  return `${header}.${body}.signature`;
})();

const cfg = {
  agents: { defaults: { model: `openai/${modelId}` } },
} satisfies OpenClawConfig;

function completedResponse(): Response {
  const response = {
    id: "resp_runtime_model",
    object: "response",
    status: "completed",
    output: [
      {
        id: "msg_runtime_model",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: '{"classification":"safe","reason":"fixture"}',
            annotations: [],
          },
        ],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };
  const events = [
    { type: "response.created", response: { ...response, output: [], status: "in_progress" } },
    { type: "response.completed", response },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "openai-model": responseModel,
      },
    },
  );
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(async () => {
  // Load the completion runtime before installing the fixture host; the application
  // bootstrap configures the production host during its first import.
  await import("../../agents/simple-completion-runtime.js");
  previousHost = getAiTransportHost();
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => vi.fn<typeof fetch>(async () => completedResponse()),
  });
  mocks.resolveSimpleCompletionSelectionForAgent.mockReset();
  mocks.resolveSimpleCompletionSelectionForAgent.mockReturnValue({
    provider: "openai",
    modelId,
    agentDir: "/tmp/openclaw-agent",
  });
  mocks.prepareSimpleCompletionModelForAgent.mockReset();
  mocks.prepareSimpleCompletionModelForAgent.mockResolvedValue({
    selection: {
      provider: "openai",
      modelId,
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: modelId,
      name: modelId,
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      input: ["text"],
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 4_096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    auth: {
      apiKey: authToken,
      source: "test",
      mode: "oauth",
      profileId: "openai:test-oauth",
    },
  });
});

afterEach(() => {
  configureAiTransportHost(previousHost);
  vi.restoreAllMocks();
});

describe("runtime.llm.complete managed ChatGPT OAuth model identity", () => {
  it("returns the concrete response model from the managed transport", async () => {
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { caller: { kind: "host", id: "reef" }, allowComplete: true },
    });

    const result = await llm.complete({
      messages: [{ role: "user", content: "Classify this fixture." }],
      requiredAuthMode: "oauth",
      responseFormat: {
        type: "json_schema",
        json_schema: {
          name: "reef_guard_verdict",
          strict: true,
          schema: { type: "object", additionalProperties: false },
        },
      },
    });

    expect(result).toMatchObject({
      text: '{"classification":"safe","reason":"fixture"}',
      provider: "openai",
      model: modelId,
      responseModel,
      stopReason: "stop",
    });
  });
});
