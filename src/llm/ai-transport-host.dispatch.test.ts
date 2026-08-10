import { getAiTransportHost } from "@openclaw/ai";
import type { Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: (options: unknown) => options,
}));

import "./ai-transport-host.js";

const model = {
  id: "gpt-test",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
} as Model<"openai-responses">;

describe("OpenClaw AI transport host dispatch callbacks", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response("ok", { status: 200 }),
      finalUrl: "https://api.openai.com/v1/responses",
      release: vi.fn(async () => undefined),
    });
  });

  it("forwards blocking and observational callbacks to the guarded fetch owner", async () => {
    const beforeFetchDispatch = vi.fn();
    const observeFetchDispatch = vi.fn();
    const onFetchDispatch = vi.fn();
    const result = getAiTransportHost().buildModelFetchWithBlockingDispatchGuard?.(
      model,
      undefined,
      {
        beforeFetchDispatch,
        observeFetchDispatch,
        onFetchDispatch,
      },
    );
    if (!result) {
      throw new Error("expected OpenClaw blocking dispatch host");
    }
    expect(result.provenance).toBe("dispatch_attested");
    await expect(
      result.fetch("https://api.openai.com/v1/responses", { method: "POST" }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeFetchDispatch,
        observeFetchDispatch,
        onFetchDispatch,
      }),
    );
  });

  it("forwards observational callbacks through the named attestation port", async () => {
    const observeFetchDispatch = vi.fn();
    const onFetchDispatch = vi.fn();
    const result = getAiTransportHost().buildModelFetchWithDispatchAttestation?.(model, undefined, {
      observeFetchDispatch,
      onFetchDispatch,
    });
    if (!result) {
      throw new Error("expected OpenClaw attested dispatch host");
    }
    expect(result.provenance).toBe("dispatch_attested");
    await result.fetch("https://api.openai.com/v1/responses");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        observeFetchDispatch,
        onFetchDispatch,
      }),
    );
  });
});
