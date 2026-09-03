/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expectedEmbedUrl,
  mount,
  resetDiscussionPanelTestState,
  type SessionDiscussionInfoLoader,
  type SessionDiscussionOpener,
  type SessionDiscussionStateListener,
} from "./session-discussion-panel.test-support.ts";

afterEach(resetDiscussionPanelTestState);

async function emptyStateText(panel: HTMLElement): Promise<string> {
  const empty = panel.querySelector("openclaw-panel-empty-state");
  expect(empty).not.toBeNull();
  await empty!.updateComplete;
  return empty!.shadowRoot?.textContent ?? "";
}

describe("session discussion panel", () => {
  it("does not render a skeleton without a loadable discussion", async () => {
    const panel = document.createElement("openclaw-session-discussion") as HTMLElement & {
      updateComplete: Promise<unknown>;
    };
    document.body.append(panel);
    try {
      await panel.updateComplete;
      expect(panel.querySelector("openclaw-panel-loading-skeleton")).toBeNull();
    } finally {
      panel.remove();
    }
  });

  it("shows the opening affordance while auto-open is in flight", async () => {
    const openDiscussion = vi
      .fn<SessionDiscussionOpener>()
      .mockImplementation(() => new Promise(() => {}));
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
    });

    await vi.waitFor(() => {
      expect(openDiscussion).toHaveBeenCalledTimes(1);
      expect(
        panel
          .querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="discussion"]')
          ?.getAttribute("aria-label"),
      ).toContain("Opening discussion");
    });
    expect(panel.querySelector("button")).toBeNull();
  });

  it("stops the skeleton when auto-open settles without opening", async () => {
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion: vi.fn().mockResolvedValue({ state: "available" }),
    });

    await vi.waitFor(async () => {
      expect(await emptyStateText(panel)).toContain("cannot be embedded");
    });
    expect(
      panel.querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="discussion"]'),
    ).toBeNull();
  });

  it("does not auto-open without operator write access", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      canOpen: false,
    });

    await vi.waitFor(async () => {
      expect(await emptyStateText(panel)).toContain("Operator write access is required");
    });
    expect(openDiscussion).not.toHaveBeenCalled();
    expect(panel.querySelector("button")).toBeNull();
  });

  it("opens once write access is granted after the discussion resolved", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockResolvedValue({
      state: "open",
      embedUrl: "https://clack.example.com/embed/channel/T1/C1",
    });
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      canOpen: false,
    });
    await vi.waitFor(async () => {
      expect(await emptyStateText(panel)).toContain("Operator write access is required");
    });
    expect(openDiscussion).not.toHaveBeenCalled();

    panel.canOpen = true;

    await vi.waitFor(() => expect(openDiscussion).toHaveBeenCalledTimes(1));
  });

  it("refetches on session switch and reports a hidden discussion", async () => {
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce({ state: "available" })
      .mockResolvedValueOnce({ state: "none" });
    const onStateChange = vi.fn<SessionDiscussionStateListener>();
    const panel = mount({ loadInfo, openDiscussion: vi.fn(), onStateChange });
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(1));

    panel.sessionKey = "agent:main:second";

    await vi.waitFor(() => {
      expect(loadInfo).toHaveBeenNthCalledWith(2, "agent:main:second");
      expect(onStateChange).toHaveBeenLastCalledWith("agent:main:second", "none", null);
    });
    expect(panel.querySelector("button")).toBeNull();
    expect(panel.querySelector("iframe")).toBeNull();
  });

  it("replaces source-owned content when the gateway generation changes", async () => {
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce({
        state: "open",
        embedUrl: "https://old.example/embed/thread",
      })
      .mockResolvedValueOnce({
        state: "open",
        embedUrl: "https://new.example/embed/thread",
      });
    const panel = mount({ loadInfo, openDiscussion: vi.fn() });
    await vi.waitFor(() => {
      expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
        expectedEmbedUrl("https://old.example/embed/thread"),
      );
    });

    panel.sourceGeneration += 1;

    await vi.waitFor(() => {
      expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
        expectedEmbedUrl("https://new.example/embed/thread"),
      );
    });
    expect(loadInfo).toHaveBeenCalledTimes(2);
  });

  it("ignores an in-flight open result after the session changes", async () => {
    let resolveFirstOpen: ((value: { state: "open"; embedUrl: string }) => void) | undefined;
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockResolvedValueOnce({ state: "available" })
      .mockResolvedValueOnce({ state: "none" });
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstOpen = resolve;
        }),
    );
    const panel = mount({ loadInfo, openDiscussion });
    await vi.waitFor(() => expect(openDiscussion).toHaveBeenCalledTimes(1));
    panel.sessionKey = "agent:main:second";

    await vi.waitFor(() => {
      expect(loadInfo).toHaveBeenCalledTimes(2);
    });
    resolveFirstOpen?.({ state: "open", embedUrl: "https://discussion.example/stale" });
    await panel.updateComplete;

    expect(openDiscussion).toHaveBeenCalledTimes(1);
    expect(panel.querySelector("iframe")).toBeNull();
    expect(
      panel.querySelector('openclaw-panel-loading-skeleton[data-panel-skeleton="discussion"]'),
    ).toBeNull();
  });

  it("does not auto-open a superseded available resolution", async () => {
    let resolveFirstLoad: ((value: { state: "available" }) => void) | undefined;
    const loadInfo = vi
      .fn<SessionDiscussionInfoLoader>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstLoad = resolve;
          }),
      )
      .mockResolvedValueOnce({ state: "none" });
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({ loadInfo, openDiscussion });
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(1));

    panel.sessionKey = "agent:main:second";
    await vi.waitFor(() => expect(loadInfo).toHaveBeenCalledTimes(2));
    resolveFirstLoad?.({ state: "available" });
    await panel.updateComplete;

    expect(openDiscussion).not.toHaveBeenCalled();
  });

  it("does not open after the available-state callback revokes write access", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      onStateChange: () => {
        panel.canOpen = false;
      },
    });

    await vi.waitFor(() => expect(panel.canOpen).toBe(false));
    expect(openDiscussion).not.toHaveBeenCalled();
  });

  it("does not render non-HTTP discussion URLs", async () => {
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "javascript:alert(1)",
        openUrl: "data:text/html,unsafe",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(async () => {
      expect(await emptyStateText(panel)).toContain("cannot be embedded");
    });
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
  });
});
