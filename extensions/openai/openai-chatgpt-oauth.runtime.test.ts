import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing } from "./openai-chatgpt-oauth.runtime.js";

describe("OpenAI Codex OAuth runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized TLS preflight timeouts before creating an abort signal", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(
      testing.runOpenAIOAuthTlsPreflight({
        timeoutMs: Number.MAX_SAFE_INTEGER,
        fetchImpl,
      }),
    ).resolves.toEqual({ ok: true });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
