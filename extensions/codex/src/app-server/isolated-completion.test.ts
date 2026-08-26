import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuthHandoff: vi.fn(),
  runBoundedTurn: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  resolveCodexAppServerPreparedAuthHandoff: mocks.resolveAuthHandoff,
}));
vi.mock("./bounded-turn.js", () => ({
  runBoundedCodexAppServerTurn: mocks.runBoundedTurn,
}));

import { runCodexIsolatedCompletion } from "./isolated-completion.js";

type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

const authProfileStore = {
  version: 1,
  profiles: {
    "openai:test": {
      type: "oauth",
      provider: "openai",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 60_000,
    },
  },
};

function createParams(): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId: "openai:test",
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore,
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir: "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    timeoutMs: 5_000,
  } as unknown as IsolatedParams;
}

describe("runCodexIsolatedCompletion", () => {
  beforeEach(() => {
    mocks.resolveAuthHandoff.mockReset();
    mocks.runBoundedTurn.mockReset();
    mocks.resolveAuthHandoff.mockResolvedValue({
      authProfileId: "openai:test",
      nativeAuthProfile: true,
    });
    mocks.runBoundedTurn.mockResolvedValue({
      text: "Garden Planning",
      model: "gpt-5.4",
      usage: { input: 7, output: 3, cacheRead: 2, total: 10 },
      items: [
        {
          id: "prompt",
          type: "userMessage",
          content: [{ type: "text", text: "Help me plan a garden." }],
        },
        { id: "reasoning", type: "reasoning" },
        { id: "answer", type: "agentMessage", text: "Garden Planning" },
      ],
    });
  });

  it("uses native authorization on a ring-zero configured-transport turn", async () => {
    const params = createParams();

    await expect(runCodexIsolatedCompletion(params, {})).resolves.toEqual({
      assistant: expect.objectContaining({
        role: "assistant",
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "gpt-5.4",
        content: [{ type: "text", text: "Garden Planning" }],
        usage: expect.objectContaining({
          input: 7,
          output: 3,
          cacheRead: 2,
          totalTokens: 10,
        }),
      }),
    });
    expect(mocks.resolveAuthHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        authRequirement: "subscription",
        authProfileId: "openai:test",
        authProfileStore,
        agentDir: "/tmp/agent",
      }),
    );
    expect(mocks.runBoundedTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { mode: "required", id: "gpt-5.4" },
        profile: "openai:test",
        authRequirement: "subscription",
        isolation: "configured-transport",
        requireNoExternalCapabilities: true,
        developerInstructions: "Name the conversation.",
        input: [{ type: "text", text: "Help me plan a garden.", text_elements: [] }],
      }),
    );
    expect(mocks.runBoundedTurn.mock.calls[0]?.[0]).not.toHaveProperty("modelProvider");
  });

  it("forwards prepared profile auth without also selecting a profile", async () => {
    const preparedAuth = {
      kind: "profile",
      profileId: "openai:test",
      store: authProfileStore,
      snapshot: {
        loginParams: { type: "chatgptAuthTokens", accessToken: "test-access" },
        secretFreeCacheKey: "test-account",
      },
    };
    mocks.resolveAuthHandoff.mockResolvedValue({
      authProfileId: "openai:test",
      nativeAuthProfile: true,
      preparedAuth,
    });

    await runCodexIsolatedCompletion(createParams(), {});

    const boundedParams = mocks.runBoundedTurn.mock.calls[0]?.[0];
    expect(boundedParams).toMatchObject({ preparedAuth });
    expect(boundedParams).not.toHaveProperty("profile");
  });

  it("rejects any native or tool item outside the passive response surface", async () => {
    mocks.runBoundedTurn.mockResolvedValue({
      text: "Garden Planning",
      model: "gpt-5.4",
      items: [{ id: "tool", type: "commandExecution" }],
    });

    await expect(runCodexIsolatedCompletion(createParams(), {})).rejects.toThrow(
      "Codex isolated completion returned unexpected native item: commandExecution",
    );
  });

  it("rejects host authorization at the native-only boundary", async () => {
    const params = createParams();
    params.authorization = {
      owner: "host",
      model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" },
      auth: { mode: "api-key", source: "test" },
    } as IsolatedParams["authorization"];

    await expect(runCodexIsolatedCompletion(params, {})).rejects.toThrow("harness-owned");
    expect(mocks.runBoundedTurn).not.toHaveBeenCalled();
  });
});
