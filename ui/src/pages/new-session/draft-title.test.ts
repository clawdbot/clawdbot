import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftTitlePreparation } from "./draft-title.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  const request = vi.fn().mockResolvedValue({ title: "Repair sidebar naming" });
  const input = { client: { request }, agentId: "main", message: "repair the sidebar naming" };
  return { request, input, titles: new DraftTitlePreparation(vi.fn()) };
}

describe("creation draft title preparation", () => {
  it("coalesces idle edits and reuses unchanged text without polling", async () => {
    const { request, input, titles } = fixture();
    titles.sync(input);
    await vi.advanceTimersByTimeAsync(900);
    const edited = { ...input, message: "repair sidebar naming and previews" };
    titles.sync(edited);
    await vi.advanceTimersByTimeAsync(900);
    expect(request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(titles.titleFor(edited)).toBe("Repair sidebar naming");
    expect(titles.titleFor(input)).toBeUndefined();
    titles.sync({ ...edited, message: ` ${edited.message} ` });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it("serializes edits behind an active request and discards the stale result", async () => {
    const { request, input, titles } = fixture();
    let finish!: (value: { title: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    titles.sync(input);
    await vi.advanceTimersByTimeAsync(1_000);
    const edited = { ...input, message: "change the topic to reconnect recovery" };
    titles.sync(edited);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).toHaveBeenCalledOnce();
    finish({ title: "Old draft" });
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    expect(titles.titleFor(edited)).toBe("Repair sidebar naming");
  });

  it("retires pending results when the draft owner closes", async () => {
    const { request, input, titles } = fixture();
    let finish!: (value: { title: string }) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    titles.sync(input);
    await vi.advanceTimersByTimeAsync(1_000);
    titles.sync(null);
    finish({ title: "Must not apply" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(titles.titleFor(input)).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not retry failures until the draft changes", async () => {
    const { request, input, titles } = fixture();
    request.mockRejectedValueOnce(new Error("provider unavailable"));
    titles.sync(input);
    await vi.advanceTimersByTimeAsync(1_000);
    titles.sync(input);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledOnce();
    expect(titles.titleFor(input)).toBeUndefined();
  });

  it("bounds source text without splitting Unicode and keeps model selection scoped", async () => {
    const { request, input, titles } = fixture();
    titles.sync({ ...input, message: "a".repeat(999) + "🦞more", model: "test/utility" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledWith(
      "sessions.title.prepare",
      {
        agentId: "main",
        message: "a".repeat(999),
        model: "test/utility",
      },
      { timeoutMs: 20_000 },
    );
    expect(titles.titleFor({ ...input, agentId: "other" })).toBeUndefined();
    expect(titles.titleFor({ ...input, client: { request: vi.fn() } })).toBeUndefined();
  });

  it.each(["", "short", "/help command"])("skips ineligible source %j", async (message) => {
    const { request, input, titles } = fixture();
    titles.sync({ ...input, message });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(request).not.toHaveBeenCalled();
  });
});
