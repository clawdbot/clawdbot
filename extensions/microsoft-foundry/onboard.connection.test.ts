// Microsoft Foundry tests cover bounded connection-test error reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as cli from "./cli.js";
import { promptTenantId, testFoundryConnection } from "./onboard.js";
import {
  ANTHROPIC_MESSAGES_API,
  DEFAULT_API,
  DEFAULT_GPT5_API,
  type FoundryProviderApi,
} from "./shared.js";

const hoisted = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: hoisted.fetchWithSsrFGuard,
}));

type FoundryConnectionRequestCase = {
  name: string;
  endpoint: string;
  modelId: string;
  modelNameHint: string;
  api: FoundryProviderApi;
  expectedUrl: string;
  expectedBody: Record<string, unknown>;
  expectedHeaders: Record<string, string>;
};

const foundryConnectionRequestCases: FoundryConnectionRequestCase[] = [
  {
    name: "Responses",
    endpoint: "https://example.services.ai.azure.com",
    modelId: "gpt-5.4",
    modelNameHint: "gpt-5.4",
    api: DEFAULT_GPT5_API,
    expectedUrl: "https://example.services.ai.azure.com/openai/v1/responses",
    expectedBody: { model: "gpt-5.4", input: "hi", max_output_tokens: 16 },
    expectedHeaders: {},
  },
  {
    name: "Chat Completions",
    endpoint: "https://example.services.ai.azure.com",
    modelId: "FW-GLM-5",
    modelNameHint: "FW-GLM-5",
    api: DEFAULT_API,
    expectedUrl: "https://example.services.ai.azure.com/openai/v1/chat/completions",
    expectedBody: {
      model: "FW-GLM-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    },
    expectedHeaders: {},
  },
  {
    name: "Anthropic Messages",
    endpoint: "https://example.services.ai.azure.com/openai/v1",
    modelId: "prod-fable",
    modelNameHint: "claude-fable-5",
    api: ANTHROPIC_MESSAGES_API,
    expectedUrl: "https://example.services.ai.azure.com/anthropic/v1/messages",
    expectedBody: {
      model: "prod-fable",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      thinking: { type: "adaptive" },
    },
    expectedHeaders: { "anthropic-version": "2023-06-01" },
  },
];

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("testFoundryConnection", () => {
  beforeEach(() => {
    vi.spyOn(cli, "getAccessTokenResult").mockReturnValue({ accessToken: "token" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    hoisted.fetchWithSsrFGuard.mockReset();
  });

  it.each(foundryConnectionRequestCases)(
    "sends the $name connection request through the guarded transport",
    async (testCase) => {
      const release = vi.fn(async () => undefined);
      hoisted.fetchWithSsrFGuard.mockResolvedValue({
        response: new Response(null, { status: 200 }),
        release,
      });

      await testFoundryConnection({
        ctx: { prompter: { note: vi.fn() } } as never,
        endpoint: testCase.endpoint,
        modelId: testCase.modelId,
        modelNameHint: testCase.modelNameHint,
        api: testCase.api,
      });

      const request = hoisted.fetchWithSsrFGuard.mock.calls[0]?.[0];
      expect(request?.url).toBe(testCase.expectedUrl);
      expect(request?.timeoutMs).toBe(15_000);
      expect(request?.init?.method).toBe("POST");
      expect(request?.init?.body).toBe(JSON.stringify(testCase.expectedBody));
      expect(new Headers(request?.init?.headers)).toEqual(
        new Headers({
          Authorization: "Bearer token",
          "Content-Type": "application/json",
          ...testCase.expectedHeaders,
        }),
      );
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds connection-test error bodies without using response.text()", async () => {
    const note = vi.fn();
    const tracked = cancelTrackedResponse(`${"foundry failure ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    hoisted.fetchWithSsrFGuard.mockResolvedValue({
      response: tracked.response,
      release: async () => {},
    });

    await testFoundryConnection({
      ctx: { prompter: { note } } as never,
      endpoint: "https://example.openai.azure.com",
      modelId: "gpt-4o",
      api: DEFAULT_API,
    });

    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.wasCanceled()).toBe(true);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Warning: test request returned 503"),
      "Connection Test",
    );
  });

  it.each([
    {
      status: 400,
      expectedPrefix:
        "Endpoint is reachable but returned 400 Bad Request - check your deployment name and API version.\n",
      expectedSuffix: "",
    },
    {
      status: 503,
      expectedPrefix: "Warning: test request returned 503. ",
      expectedSuffix: "\nProceeding anyway - you can fix the endpoint later.",
    },
  ])(
    "keeps $status error-body previews UTF-16 safe",
    async ({ status, expectedPrefix, expectedSuffix }) => {
      const note = vi.fn();
      const prefix = "x".repeat(199);
      hoisted.fetchWithSsrFGuard.mockResolvedValue({
        response: new Response(`${prefix}😀tail`, { status }),
        release: async () => {},
      });

      await testFoundryConnection({
        ctx: { prompter: { note } } as never,
        endpoint: "https://example.openai.azure.com",
        modelId: "gpt-4o",
        api: DEFAULT_API,
      });

      expect(note).toHaveBeenCalledExactlyOnceWith(
        `${expectedPrefix}${prefix}${expectedSuffix}`,
        "Connection Test",
      );
    },
  );
});

describe("promptTenantId", () => {
  it("validates tenant domains and UUIDs through the prompt boundary", async () => {
    const text = vi.fn(async (options: { validate?: (value: string) => string | undefined }) => {
      expect(options.validate?.("contoso.onmicrosoft.com")).toBeUndefined();
      expect(options.validate?.("00000000-0000-0000-0000-000000000000")).toBeUndefined();
      expect(options.validate?.("not a tenant")).toBe("Enter a valid tenant ID or tenant domain");
      expect(options.validate?.("")).toBe("Tenant ID is required");
      return "contoso.onmicrosoft.com";
    });

    await expect(promptTenantId({ prompter: { text } } as never, { required: true })).resolves.toBe(
      "contoso.onmicrosoft.com",
    );
    expect(text).toHaveBeenCalledTimes(1);
  });
});
