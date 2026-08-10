import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { buildGuardedModelFetch } from "./host-policy.js";

const initialHost = getAiTransportHost();
const model: Model<"openai-responses"> = {
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
};

afterEach(() => {
  vi.unstubAllGlobals();
  configureAiTransportHost(initialHost);
});

describe("model fetch dispatch guards", () => {
  it("fails closed when the host cannot install a blocking guard", () => {
    const legacyBuilder = vi.fn(() => undefined);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: legacyBuilder,
      buildModelFetchWithBlockingDispatchGuard: undefined,
    });

    expect(() =>
      buildGuardedModelFetch(model, undefined, {
        beforeFetchDispatch: vi.fn(),
      }),
    ).toThrow("blocking model fetch dispatch guard is unavailable");
    expect(legacyBuilder).not.toHaveBeenCalled();
  });

  it("uses only the named blocking port when dispatch authority is required", async () => {
    const legacyBuilder = vi.fn(() => undefined);
    const blockingFetch = vi.fn(async () => new Response("ok"));
    const blockingBuilder = vi.fn(() => ({
      fetch: blockingFetch,
      provenance: "dispatch_attested" as const,
    }));
    const beforeFetchDispatch = vi.fn();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: legacyBuilder,
      buildModelFetchWithBlockingDispatchGuard: blockingBuilder,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, {
      beforeFetchDispatch,
      onFetchDispatch: vi.fn(),
    });
    await expect(guardedFetch("https://api.openai.com/v1/responses")).resolves.toMatchObject({
      status: 200,
    });

    expect(legacyBuilder).not.toHaveBeenCalled();
    expect(blockingBuilder).toHaveBeenCalledWith(
      model,
      undefined,
      expect.objectContaining({ beforeFetchDispatch }),
    );
    expect(blockingFetch).toHaveBeenCalledOnce();
  });

  it("fails closed when the named blocking port declines the request", () => {
    const legacyBuilder = vi.fn(() => undefined);
    const blockingBuilder = vi.fn(() => undefined);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: legacyBuilder,
      buildModelFetchWithBlockingDispatchGuard: blockingBuilder,
    });

    expect(() =>
      buildGuardedModelFetch(model, undefined, {
        beforeFetchDispatch: vi.fn(),
      }),
    ).toThrow("blocking model fetch dispatch guard is unavailable");
    expect(blockingBuilder).toHaveBeenCalledOnce();
    expect(legacyBuilder).not.toHaveBeenCalled();
  });

  it("fails closed when the named blocking port returns a bare callable", () => {
    const blockingFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithBlockingDispatchGuard: (() => blockingFetch) as never,
    });

    expect(() =>
      buildGuardedModelFetch(model, undefined, {
        beforeFetchDispatch: vi.fn(),
      }),
    ).toThrow("blocking model fetch dispatch guard is unavailable");
  });

  it("keeps observational dispatch accounting isolated in the fallback", async () => {
    const onFetchDispatch = vi.fn(() => {
      throw new Error("observer failure");
    });
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
      buildModelFetchWithBlockingDispatchGuard: undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });
    const response = await guardedFetch("https://api.openai.com/v1/responses");

    expect(response.status).toBe(200);
    expect(onFetchDispatch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
