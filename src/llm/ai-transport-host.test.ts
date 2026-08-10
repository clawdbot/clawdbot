import {
  configureAiTransportHost,
  createApiRegistry,
  getAiTransportHost,
  type Api,
  type Context,
  type Model,
} from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { projectProviderError } from "../../packages/ai/src/utils/provider-error.js";
import "./ai-transport-host.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

const modelBase = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  provider: "openai",
  baseUrl: "https://api.openai.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Omit<Model, "api">;

function createJwt(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-registered" },
  })}.signature`;
}

describe("OpenClaw AI transport host diagnostics", () => {
  let initialHost: ReturnType<typeof getAiTransportHost>;

  beforeAll(() => {
    initialHost = getAiTransportHost();
  });

  afterEach(() => {
    configureAiTransportHost(initialHost);
    vi.unstubAllGlobals();
  });

  afterAll(() => configureAiTransportHost(initialHost));

  it("strengthens the package projection with core credential redaction", () => {
    const secret = "sensitive-provider-key";
    const projected = projectProviderError({
      status: 502,
      body: { message: "provider failed", apiKey: secret },
    });

    expect(projected.errorMessage).toContain("provider failed");
    expect(JSON.stringify(projected)).not.toContain(secret);
  });

  it.each([
    {
      api: "openai-responses",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "sk-openai-test",
    },
    {
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/v1",
      apiKey: "sk-azure-test",
    },
    {
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.test/backend-api",
      apiKey: createJwt(),
      transport: "sse",
    },
    {
      api: "mistral-conversations",
      baseUrl: "https://api.mistral.test",
      apiKey: "sk-mistral-test",
    },
  ] as const)("redacts registered $api response failures", async (fixture) => {
    const media = "data:video/mp4;base64,QUJDRA==";
    const credential = "Bearer registered-provider-secret-123456";
    const fetchMock: typeof fetch = async () =>
      Response.json(
        {
          error: {
            type: "invalid_request_error",
            code: "reflected_input",
            message: `rejected ${media} with ${credential}`,
          },
        },
        { status: 400 },
      );
    configureAiTransportHost({ ...initialHost, buildModelFetch: () => fetchMock });
    if (fixture.api === "openai-chatgpt-responses") {
      vi.stubGlobal("fetch", fetchMock);
    }
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const provider = registry.getApiProvider(fixture.api as Api);
    if (!provider) {
      throw new Error(`missing registered provider: ${fixture.api}`);
    }
    const model: Model = { ...modelBase, api: fixture.api, baseUrl: fixture.baseUrl };

    const result = await provider
      .stream(model, context, {
        apiKey: fixture.apiKey,
        maxRetries: 0,
        ...(fixture.api === "openai-chatgpt-responses" ? { transport: fixture.transport } : {}),
      })
      .result();
    const terminal = JSON.stringify({
      errorMessage: result.errorMessage,
      errorCode: result.errorCode,
      errorType: result.errorType,
      errorBody: result.errorBody,
    });

    expect(result.stopReason).toBe("error");
    expect(terminal).toContain("<redacted>");
    expect(terminal).not.toContain("QUJDRA==");
    expect(terminal).not.toContain("registered-provider-secret-123456");
  });
});
