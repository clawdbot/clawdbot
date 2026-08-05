import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, runChannelProbe } from "./text-utility-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("escapeHtml", () => {
  it("escapes five HTML-sensitive characters and existing entity markers", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });
});

describe("runChannelProbe", () => {
  it("adds elapsed time to successful results", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);

    await expect(
      runChannelProbe(
        undefined,
        async ({ startedAt }) => ({ ok: startedAt === 100 }),
        (error) => ({ ok: false, error: String(error) }),
      ),
    ).resolves.toEqual({ ok: true, elapsedMs: 45 });
  });

  it("preserves an explicit timing snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(120);

    await expect(
      runChannelProbe(
        undefined,
        async ({ elapsedMs }) => ({ ok: true, elapsedMs: elapsedMs() }),
        (error) => ({ ok: false, error: String(error) }),
      ),
    ).resolves.toEqual({ ok: true, elapsedMs: 20 });
  });

  it("applies the timeout before shaping the error result", async () => {
    vi.useFakeTimers();
    const resultPromise = runChannelProbe(
      50,
      async () => await new Promise<never>(() => {}),
      (error) => ({ ok: false, error: String(error) }),
    );

    await vi.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Error: timeout",
      elapsedMs: 50,
    });
  });
});
