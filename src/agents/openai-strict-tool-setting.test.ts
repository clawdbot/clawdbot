import { streamOpenAIResponses } from "@openclaw/ai/internal/openai";
import type { Context } from "@openclaw/ai/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenAIStrictToolSetting } from "./openai-strict-tool-setting.js";
import {
  buildOpenAIResponsesParams,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";

const unexpectedFetch = vi.fn(() => {
  throw new Error("Unexpected network request");
});

beforeEach(() => {
  unexpectedFetch.mockClear();
  vi.stubGlobal("fetch", unexpectedFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Copilot Responses optional tool fields", () => {
  it.each(
    (["provider", "transport"] as const).flatMap((entrypoint) =>
      [undefined, false, true].map((supportsStrictMode) => ({ entrypoint, supportsStrictMode })),
    ),
  )(
    "preserves optional UUIDs in $entrypoint requests with supportsStrictMode=$supportsStrictMode",
    async ({ entrypoint, supportsStrictMode }) => {
      const model = makeResponsesModel({
        provider: "github-copilot",
        baseUrl: "https://api.individual.githubcopilot.com",
        reasoning: false,
        ...(supportsStrictMode === undefined ? {} : { compat: { supportsStrictMode } }),
      });
      const parameters = {
        type: "object",
        properties: {
          title: { type: "string" },
          folder_id: { type: "string", format: "uuid" },
        },
        required: ["title"],
        additionalProperties: false,
      };
      const originalParameters = structuredClone(parameters);
      const context: Context = {
        messages: [{ role: "user", content: "Create an item without a folder", timestamp: 1 }],
        tools: [{ name: "create_item", description: "Create an item", parameters }],
      };
      let payload: unknown;
      if (entrypoint === "transport") {
        payload = buildOpenAIResponsesParams(model, context, undefined);
      } else {
        // Exercise the provider's real builder, but stop before any API request.
        const stream = streamOpenAIResponses(model, context, {
          apiKey: "synthetic-key",
          onPayload: (request) => {
            payload = request;
            throw new Error("Request captured before dispatch");
          },
        });
        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("Request captured before dispatch");
      }
      expect(unexpectedFetch).not.toHaveBeenCalled();
      // Check serialized request bytes as well as the caller's original schema:
      // the UUID stays optional and string-only, without nullable substitutes.
      const serializedPayload = JSON.stringify(payload);
      expect(JSON.parse(serializedPayload)).toHaveProperty("tools", [
        {
          type: "function",
          name: "create_item",
          description: "Create an item",
          strict: false,
          parameters: originalParameters,
        },
      ]);
      expect(parameters).toEqual(originalParameters);
    },
  );
});

describe("resolveOpenAIStrictToolSetting sibling routes", () => {
  it.each([
    {
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      expected: true,
    },
    {
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      expected: true,
    },
    {
      provider: "azure-openai",
      api: "openai-responses",
      baseUrl: "https://example.openai.azure.com",
      expected: true,
    },
    {
      provider: "azure-openai-responses",
      api: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com/openai/responses",
      expected: true,
    },
    {
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      expected: undefined,
    },
    {
      provider: "custom-provider",
      api: "openai-responses",
      baseUrl: "https://proxy.example.com/v1",
      expected: undefined,
    },
    {
      provider: "github-copilot",
      api: "openai-completions",
      baseUrl: "https://api.individual.githubcopilot.com",
      expected: undefined,
    },
    {
      provider: "github-copilot",
      api: "anthropic-messages",
      baseUrl: "https://api.individual.githubcopilot.com",
      expected: undefined,
    },
  ])("keeps $provider / $api at $baseUrl unchanged", ({ expected, ...model }) => {
    expect(resolveOpenAIStrictToolSetting(model)).toBe(expected);
    expect(resolveOpenAIStrictToolSetting(model, { supportsStrictMode: false })).toBe(expected);
    expect(resolveOpenAIStrictToolSetting(model, { supportsStrictMode: true })).toBe(
      expected ?? false,
    );
  });
});
