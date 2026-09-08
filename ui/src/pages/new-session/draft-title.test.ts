import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftTitleFixture } from "./draft-title.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

function fixture() {
  const prepare = vi.fn().mockResolvedValue({ title: "Repair sidebar naming" });
  return { ...createDraftTitleFixture(prepare), prepare };
}

describe("creation draft title preparation", () => {
  it("coalesces idle edits and reuses unchanged text without polling", async () => {
    const { flow, prepare, titles } = fixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(900);
    flow.setMessage("repair sidebar naming and previews");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(900);
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    flow.setMessage(" repair sidebar naming and previews ");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).toHaveBeenCalledOnce();
    expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
  });

  it("serializes edits behind an active request and discards the stale result", async () => {
    const { flow, prepare, titles } = fixture();
    let finish!: (value: { title: string }) => void;
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    flow.setMessage("change the topic to reconnect recovery");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).toHaveBeenCalledOnce();
    finish({ title: "Old draft" });
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(titles.takePreparedTitle()).toBe("Repair sidebar naming");
  });

  it("retires pending results when the draft owner closes", async () => {
    const { flow, prepare, titles } = fixture();
    let finish!: (value: { title: string }) => void;
    prepare.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    titles.hostDisconnected();
    finish({ title: "Must not apply" });
    await vi.advanceTimersByTimeAsync(5_000);
    titles.hostConnected();
    expect(titles.takePreparedTitle()).toBeUndefined();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("does not retry failures until the draft changes", async () => {
    const { flow, prepare, titles } = fixture();
    prepare.mockRejectedValueOnce(new Error("provider unavailable"));
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(prepare).toHaveBeenCalledOnce();
    expect(titles.takePreparedTitle()).toBeUndefined();
  });

  it("bounds source text without splitting Unicode and keeps model selection scoped", async () => {
    const { flow, place, request, titles } = fixture();
    flow.setMessage("a".repeat(999) + "🦞more");
    place.modelControl.selected = "test/utility";
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledWith(
      "sessions.title.prepare",
      { agentId: "main", message: "a".repeat(999), model: "test/utility" },
      { timeoutMs: 20_000 },
    );
    place.modelControl.selected = "test/other";
    expect(titles.takePreparedTitle()).toBeUndefined();
  });

  it.each(["", "short", "/help command"])("skips ineligible source %j", async (message) => {
    const { flow, prepare, titles } = fixture();
    flow.setMessage(message);
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(prepare).not.toHaveBeenCalled();
  });
});
