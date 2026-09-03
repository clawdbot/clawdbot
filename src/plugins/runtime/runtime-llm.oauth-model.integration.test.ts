import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginRuntimePluginIdScope } from "./gateway-request-scope.js";
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

const pluginCfg = {
  ...cfg,
  plugins: {
    entries: {
      "trusted-plugin": {
        llm: {
          allowModelOverride: true,
          allowedModels: [`openai/${modelId}`],
        },
      },
    },
  },
} satisfies OpenClawConfig;

function preparedOauthModel(profileId = "openai:test-oauth") {
  return {
    selection: {
      provider: "openai",
      modelId,
      profileId,
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
      profileId,
    },
  };
}

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
const modelFetch = vi.fn<typeof fetch>();

beforeEach(async () => {
  // Initialize the lazily loaded agent host before installing the fixture override;
  // otherwise the first completion replaces this host and selects native WebSocket.
  await import("../../agents/ai-transport-runtime-host.js");
  previousHost = getAiTransportHost();
  modelFetch.mockReset();
  modelFetch.mockImplementation(async () => completedResponse());
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => modelFetch,
    plugin: {
      ...previousHost.plugin,
      resolveProviderStream: () => undefined,
      resolveTransportTurnState: () => undefined,
      wrapSimpleCompletionStream: () => undefined,
    },
  });
  mocks.resolveSimpleCompletionSelectionForAgent.mockReset();
  mocks.resolveSimpleCompletionSelectionForAgent.mockReturnValue({
    provider: "openai",
    modelId,
    agentDir: "/tmp/openclaw-agent",
  });
  mocks.prepareSimpleCompletionModelForAgent.mockReset();
  mocks.prepareSimpleCompletionModelForAgent.mockResolvedValue(preparedOauthModel());
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
      signal: AbortSignal.timeout(30_000),
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
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("requires the selected credential to use the requested OAuth mode", async () => {
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce({
      ...preparedOauthModel(),
      auth: { apiKey: "test-api-key", source: "test", mode: "api-key" },
    });
    const llm = createRuntimeLlm({
      getConfig: () => cfg,
      authority: { caller: { kind: "host", id: "runtime-test" }, allowComplete: true },
    });

    await expect(
      llm.complete({
        messages: [{ role: "user", content: "Ping" }],
        requiredAuthMode: "oauth",
      }),
    ).rejects.toThrow("selected a credential with the wrong authentication mode");
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("binds a direct model override to its selected OAuth profile", async () => {
    const profileId = "openai:work";
    mocks.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId,
      profileId,
      agentDir: "/tmp/openclaw-agent",
    });
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce(preparedOauthModel(profileId));
    const llm = createRuntimeLlm({
      getConfig: () => pluginCfg,
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: `openai/${modelId}@${profileId}`,
          messages: [{ role: "user", content: "Ping" }],
          requiredAuthMode: "oauth",
        }),
      ),
    ).resolves.toMatchObject({ text: '{"classification":"safe","reason":"fixture"}' });
    expect(mocks.prepareSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRef: `openai/${modelId}@${profileId}`,
        bindAuthOwner: true,
      }),
    );
  });

  it("rejects a direct model override resolved to another OAuth profile", async () => {
    const profileId = "openai:work";
    mocks.resolveSimpleCompletionSelectionForAgent.mockReturnValueOnce({
      provider: "openai",
      modelId,
      profileId,
      agentDir: "/tmp/openclaw-agent",
    });
    mocks.prepareSimpleCompletionModelForAgent.mockResolvedValueOnce(
      preparedOauthModel("openai:other"),
    );
    const llm = createRuntimeLlm({
      getConfig: () => pluginCfg,
      authority: { allowComplete: true },
    });

    await expect(
      withPluginRuntimePluginIdScope("trusted-plugin", () =>
        llm.complete({
          model: `openai/${modelId}@${profileId}`,
          messages: [{ role: "user", content: "Ping" }],
          requiredAuthMode: "oauth",
        }),
      ),
    ).rejects.toThrow("selected a different authentication profile");
    expect(modelFetch).not.toHaveBeenCalled();
  });
});
