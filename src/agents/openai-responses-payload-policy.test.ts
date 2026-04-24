import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyOpenAIResponsesPayloadPolicy,
  resolveOpenAIResponsesPayloadPolicy,
} from "./openai-responses-payload-policy.js";

describe("openai responses payload policy", () => {
  it("forces store for native OpenAI responses payloads but keeps disable mode for transport defaults", () => {
    const model = {
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    } satisfies Model<"openai-responses">;

    expect(
      resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "provider-policy" }),
    ).toMatchObject({
      explicitStore: true,
      allowsServiceTier: true,
    });
    expect(resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" })).toMatchObject({
      explicitStore: false,
      allowsServiceTier: true,
    });
  });

  it("couples native Responses server compaction to provider-managed store", () => {
    const model = {
      id: "gpt-5.4",
      api: "openai-responses",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 200_000,
    } satisfies Pick<
      Model<"openai-responses">,
      "api" | "baseUrl" | "contextWindow" | "id" | "provider"
    >;
    const payload = {} satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(model, {
        enableServerCompaction: true,
        storeMode: "provider-policy",
      }),
    );

    expect(payload).toEqual({
      store: true,
      context_management: [{ type: "compaction", compact_threshold: 140_000 }],
    });
  });

  it("strips store and prompt cache for proxy-like responses routes when requested", () => {
    const policy = resolveOpenAIResponsesPayloadPolicy(
      {
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1",
        compat: { supportsStore: false },
      },
      {
        enablePromptCacheStripping: true,
        storeMode: "provider-policy",
      },
    );
    const payload = {
      store: false,
      prompt_cache_key: "session-123",
      prompt_cache_retention: "24h",
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(payload, policy);

    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  });

  it("keeps disabled reasoning payloads on native OpenAI responses models that support none", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
          baseUrl: "https://api.openai.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      reasoning: {
        effort: "none",
      },
      store: false,
    });
  });

  it("strips disabled reasoning payloads on native OpenAI responses models that do not support none", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5",
          baseUrl: "https://api.openai.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).toEqual({
      store: false,
    });
  });

  it("strips disabled reasoning payloads for proxy-like OpenAI responses routes", () => {
    const payload = {
      reasoning: {
        effort: "none",
      },
    } satisfies Record<string, unknown>;

    applyOpenAIResponsesPayloadPolicy(
      payload,
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-responses",
          provider: "openai",
          baseUrl: "https://proxy.example.com/v1",
        },
        { storeMode: "disable" },
      ),
    );

    expect(payload).not.toHaveProperty("reasoning");
  });

  it("emits store false for native OpenAI Codex responses disable mode", () => {
    expect(
      resolveOpenAIResponsesPayloadPolicy(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          baseUrl: "https://chatgpt.com/backend-api/codex",
        },
        { storeMode: "disable" },
      ),
    ).toMatchObject({
      explicitStore: false,
      allowsServiceTier: true,
      shouldStripStore: false,
    });
  });
});
