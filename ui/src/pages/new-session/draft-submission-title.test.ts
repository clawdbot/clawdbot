import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDraftTitleFixture } from "./draft-title.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

describe("prepared title creation handoff", () => {
  it.each(["codex", "claude"])(
    "does not send a native %s draft to title inference",
    async (catalogId) => {
      const { flow, request, titles } = createDraftTitleFixture(undefined, {
        agentId: "main",
        requestedAgentId: "main",
        catalogId,
        catalogLabel: catalogId,
        model: "",
        startTerminal: true,
      });
      flow.setMessage("inspect this native-only workspace");
      titles.hostUpdated();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
      ).toHaveLength(0);
    },
  );

  it("uses a ready title at creation without changing an explicit worktree name", async () => {
    const { flow, context, place, titles } = createDraftTitleFixture();
    place.selectWorktree(true);
    place.setWorktreeName("my-explicit-branch");
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Repair naming", worktreeName: "my-explicit-branch" }),
      { reconciliation: "background" },
    );
  });

  it("sends immediately while preparation is pending and ignores its late result", async () => {
    let finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { flow, context, titles } = createDraftTitleFixture(async () => pending);
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
    finish({ title: "Too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(titles.takePreparedTitle()).toBeUndefined();
  });

  it("never sends an incognito draft and discards an earlier normal suggestion", async () => {
    const { flow, request, context, titles } = createDraftTitleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    flow.setVisibility("incognito");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).toMatchObject({
      incognito: true,
    });
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
  });

  it("does not restart speculation when a submitted draft is retried", async () => {
    const { flow, request, titles } = createDraftTitleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    await flow.submit();
    await flow.submit();
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.title.prepare"),
    ).toHaveLength(1);
  });

  it("rejects a stale title even when Send beats the next UI update", async () => {
    const { flow, context, titles } = createDraftTitleFixture();
    flow.setMessage("repair the sidebar naming");
    titles.hostUpdated();
    await vi.advanceTimersByTimeAsync(1_000);
    flow.setMessage("investigate a different reconnect bug");
    expect(flow.submitBlock()).toBeUndefined();
    await flow.submit();
    expect(vi.mocked(context.sessions.createResult).mock.calls[0]?.[0]).not.toHaveProperty(
      "displayName",
    );
  });
});
