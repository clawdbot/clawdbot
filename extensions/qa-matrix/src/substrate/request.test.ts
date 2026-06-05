// Qa Matrix tests cover request plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";

describe("requestMatrixJson", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating the abort signal", async () => {
    const signal = AbortSignal.abort();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<MatrixQaFetchLike>(async () => Response.json({ ok: true }));

    await requestMatrixJson({
      baseUrl: "https://matrix.example.test",
      endpoint: "/_matrix/client/v3/account/whoami",
      fetchImpl,
      method: "GET",
      timeoutMs: MAX_TIMER_TIMEOUT_MS + 1_000_000,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ signal }));
  });
});
