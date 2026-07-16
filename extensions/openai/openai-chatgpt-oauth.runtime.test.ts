// Openai tests cover openai chatgpt oauth plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOpenAIOAuthTlsPreflight } from "./openai-chatgpt-oauth-preflight.runtime.js";

describe("OpenAI Codex OAuth runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized TLS preflight timeouts before creating an abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(
      runOpenAIOAuthTlsPreflight({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels reachable TLS preflight response bodies", async () => {
    const response = new Response("reachable", { status: 302 });
    const cancel = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const fetchImpl = vi.fn(async () => response);

    await expect(
      runOpenAIOAuthTlsPreflight({
        timeoutMs: 20,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(cancel).toHaveBeenCalledOnce();
  });
});
