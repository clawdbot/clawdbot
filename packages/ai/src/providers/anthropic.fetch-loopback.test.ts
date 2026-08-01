import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

type CapturedRequest = {
  method: string;
  path: string;
  authorization?: string;
  apiKey?: string;
};

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

function makeModel(overrides: Partial<Model<"anthropic-messages">>) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

afterEach(() => {
  configureAiTransportHost({});
});

describe("Anthropic SDK host fetch wiring", () => {
  it("routes every non-Cloudflare client branch through the host fetch", async () => {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        apiKey: request.headers["x-api-key"] as string | undefined,
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "test rejection" },
        }),
      );
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const hostFetch = vi.fn<typeof fetch>((input, init) => globalThis.fetch(input, init));
    const buildModelFetch = vi.fn(() => hostFetch);
    configureAiTransportHost({ buildModelFetch });

    const cases = [
      {
        model: makeModel({ provider: "github-copilot", baseUrl }),
        apiKey: "copilot-token",
      },
      {
        model: makeModel({ provider: "microsoft-foundry", baseUrl, authHeader: true }),
        apiKey: "foundry-token",
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-oat01-oauth-token", // pragma: allowlist secret
      },
      {
        model: makeModel({ baseUrl }),
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        model: makeModel({ provider: "kimi-coding", baseUrl }),
        apiKey: "kimi-api-key",
        thinkingEnabled: true,
      },
    ];

    try {
      for (const testCase of cases) {
        const result = await streamAnthropic(testCase.model, context, {
          apiKey: testCase.apiKey,
          maxRetries: 0,
          thinkingEnabled: testCase.thinkingEnabled,
        }).result();
        expect(result.stopReason).toBe("error");
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    expect(hostFetch).toHaveBeenCalledTimes(cases.length);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer copilot-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer foundry-token",
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: "Bearer sk-ant-oat01-oauth-token", // pragma: allowlist secret
        apiKey: undefined,
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "sk-ant-api03-api-key", // pragma: allowlist secret
      },
      {
        method: "POST",
        path: "/v1/messages",
        authorization: undefined,
        apiKey: "kimi-api-key",
      },
    ]);
    expect(buildModelFetch).toHaveBeenLastCalledWith(cases.at(-1)?.model, undefined, {
      sanitizeSse: false,
    });
  });
});
