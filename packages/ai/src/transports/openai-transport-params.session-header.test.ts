import type { Context, Model, SimpleStreamOptions } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "../providers/openai-prompt-cache.js";
import {
  buildOpenAIClientHeaders,
  buildOpenAISdkRequestOptions,
} from "./openai-transport-params.js";

const codexModel = {
  id: "gpt-5.6-luna",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as Model;

const context = { messages: [] } as unknown as Context;

const proxyResponsesModel = {
  id: "gpt-5.5",
  provider: "openai-proxy",
  api: "openai-responses",
  baseUrl: "https://responses-proxy.example.test/v1",
  compat: { sendSessionIdHeader: true },
} as Model;

describe("buildOpenAIClientHeaders session_id affinity header", () => {
  it("clamps long internal session ids to the backend's 64-char cache key limit", () => {
    const longSessionId = `internal-session-effects-session-companion-${"a".repeat(50)}`;
    const headers = buildOpenAIClientHeaders(
      codexModel,
      context,
      undefined,
      undefined,
      longSessionId,
    );
    const sessionHeader = headers.session_id;
    expect(Array.from(sessionHeader ?? "").length).toBeLessThanOrEqual(
      OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
    );
    expect(sessionHeader?.startsWith("internal-session-effects-session-companion-")).toBe(true);
  });

  it("passes short session ids through unchanged", () => {
    const headers = buildOpenAIClientHeaders(codexModel, context, undefined, undefined, "abc-123");
    expect(headers.session_id).toBe("abc-123");
  });

  it("honors the explicit Responses proxy session header opt-in", () => {
    const headers = buildOpenAIClientHeaders(
      proxyResponsesModel,
      context,
      undefined,
      undefined,
      "proxy-session-123",
    );

    expect(headers.session_id).toBe("proxy-session-123");
  });

  it("honors an explicit native Responses session header opt-out", () => {
    const headers = buildOpenAIClientHeaders(
      { ...codexModel, compat: { sendSessionIdHeader: false } },
      context,
      undefined,
      undefined,
      "native-session-123",
    );

    expect(headers.session_id).toBeUndefined();
  });

  it("omits generated Responses session headers when caching is disabled", () => {
    const headers = buildOpenAIClientHeaders(
      proxyResponsesModel,
      context,
      undefined,
      undefined,
      "proxy-session-123",
      "none",
    );

    expect(headers.session_id).toBeUndefined();
  });
});

describe("buildOpenAISdkRequestOptions turn controls", () => {
  const model = {
    id: "gpt-5.6-luna",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  } as Model;

  it.each([undefined, 0, 7])("keeps SDK retries at zero for legacy maxRetries=%s", (maxRetries) => {
    const signal = new AbortController().signal;
    const options: SimpleStreamOptions = { timeoutMs: 1_234, maxRetries };

    expect(buildOpenAISdkRequestOptions(model, signal, options)).toEqual({
      signal,
      timeout: 1_234,
      maxRetries: 0,
    });
  });

  it("does not add a retry policy when the turn does not specify one", () => {
    expect(buildOpenAISdkRequestOptions(model)).toBeUndefined();
  });
});
