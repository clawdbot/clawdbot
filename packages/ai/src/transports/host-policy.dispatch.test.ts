import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { buildGuardedModelFetch, buildGuardedModelFetchResult } from "./host-policy.js";

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

describe("hostless model fetch dispatch accounting", () => {
  it("preserves the legacy callable contract with explicit undefined options", () => {
    const hostFetch = vi.fn<typeof fetch>();
    const legacyBuilder = vi.fn(() => hostFetch);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: legacyBuilder,
    });

    const publicResult: typeof fetch | undefined = getAiTransportHost().buildModelFetch(
      model,
      undefined,
      undefined,
    );
    const result = buildGuardedModelFetchResult(model, undefined, undefined);

    expect(publicResult).toBe(hostFetch);
    expect(result.fetch).toBe(hostFetch);
    expect(legacyBuilder).toHaveBeenNthCalledWith(1, model, undefined, undefined);
    expect(legacyBuilder).toHaveBeenNthCalledWith(2, model);
  });

  it("keeps bare host fetch provenance unknown", () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => hostFetch,
    });

    const result = buildGuardedModelFetchResult(model, undefined, {
      onFetchDispatch: vi.fn(),
    });

    expect(result).toMatchObject({ fetch: hostFetch });
  });

  it("preserves structured host dispatch attestation privately", () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: () => ({
        fetch: hostFetch,
        provenance: "dispatch_attested" as const,
      }),
    });

    const result = buildGuardedModelFetchResult(model, undefined, {
      onFetchDispatch: vi.fn(),
    });

    expect(result).toMatchObject({
      fetch: hostFetch,
      physicalDispatchAttested: true,
      provenance: "dispatch_attested",
    });
  });

  it("rejects a bare callable returned by the named attestation port", () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: (() => hostFetch) as never,
    });

    expect(() =>
      buildGuardedModelFetchResult(model, undefined, {
        onFetchDispatch: vi.fn(),
      }),
    ).toThrow("invalid dispatch contract");
  });

  it("does not accept structured attestation from the legacy callable-only port", () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: (() => ({
        fetch: hostFetch,
        provenance: "dispatch_attested",
      })) as never,
    });

    const result = buildGuardedModelFetchResult(model, undefined, {});

    expect(result.fetch).not.toBe(hostFetch);
    expect(result.provenance).toBeUndefined();
  });

  it.each([
    { name: "without options", timeoutMs: undefined },
    { name: "with only a timeout", timeoutMs: 1_000 },
  ])("rejects structured legacy results $name", ({ timeoutMs }) => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: (() => ({
        fetch: hostFetch,
        provenance: "dispatch_attested",
      })) as never,
    });

    const result = buildGuardedModelFetchResult(model, timeoutMs);

    expect(result.fetch).not.toBe(hostFetch);
    expect(result.provenance).toBeUndefined();
  });

  it("keeps provenance build-local when one fetch function is reused", () => {
    const hostFetch = vi.fn<typeof fetch>();
    const buildAttestedModelFetch = vi
      .fn()
      .mockReturnValueOnce({ fetch: hostFetch, provenance: "dispatch_attested" as const })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ fetch: hostFetch, provenance: "dispatch_attested" as const });
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => hostFetch,
      buildModelFetchWithDispatchAttestation: buildAttestedModelFetch,
    });

    expect(buildGuardedModelFetchResult(model, undefined, {})).toMatchObject({
      fetch: hostFetch,
      provenance: "dispatch_attested",
    });
    expect(buildGuardedModelFetchResult(model, undefined, {})).toMatchObject({ fetch: hostFetch });
    expect(buildGuardedModelFetchResult(model, undefined, {})).toMatchObject({ fetch: hostFetch });
    expect(buildGuardedModelFetchResult(model, undefined, {})).toMatchObject({
      fetch: hostFetch,
      provenance: "dispatch_attested",
    });
  });

  it("calls optional attestation ports only when they are callable", () => {
    const hostFetch = vi.fn<typeof fetch>();
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => hostFetch,
      buildModelFetchWithDispatchAttestation: null as never,
    });

    expect(buildGuardedModelFetchResult(model, undefined, {}).fetch).toBe(hostFetch);
  });

  it("records after fetch invocation and isolates observer failures", async () => {
    const order: string[] = [];
    const onFetchDispatch = vi.fn(() => {
      order.push("observe");
      throw new Error("observer failure");
    });
    const fetchMock = vi.fn(() => {
      order.push("fetch");
      return Promise.resolve(new Response("ok"));
    });
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const result = buildGuardedModelFetchResult(model, undefined, { onFetchDispatch });
    expect(result.physicalDispatchAttested).toBe(false);
    expect(result.provenance).toBeUndefined();
    const response = await result.fetch("https://api.openai.com/v1/responses");

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).toHaveBeenCalledOnce();
    expect(order).toEqual(["fetch", "observe"]);
  });

  it("does not record a dispatch when fetch throws before submission", async () => {
    const failure = new Error("fetch invocation failed");
    const onFetchDispatch = vi.fn();
    const fetchMock = vi.fn(() => {
      throw failure;
    });
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });

    await expect(guardedFetch("https://api.openai.com/v1/responses")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).not.toHaveBeenCalled();
  });

  it("records a dispatch when fetch returns a rejected promise", async () => {
    const failure = new Error("remote fetch failed");
    const onFetchDispatch = vi.fn();
    const fetchMock = vi.fn(() => Promise.reject(failure));
    vi.stubGlobal("fetch", fetchMock);
    configureAiTransportHost({
      ...initialHost,
      buildModelFetch: () => undefined,
    });

    const guardedFetch = buildGuardedModelFetch(model, undefined, { onFetchDispatch });

    await expect(guardedFetch("https://api.openai.com/v1/responses")).rejects.toBe(failure);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onFetchDispatch).toHaveBeenCalledOnce();
  });
});
