/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SessionDiscussionInfoLoader,
  SessionDiscussionOpener,
  SessionDiscussionStateListener,
} from "./session-discussion-panel.ts";
import "./session-discussion-panel.ts";

type DiscussionPanelElement = HTMLElement & {
  sessionKey: string;
  canOpen: boolean;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange: SessionDiscussionStateListener;
  updateComplete: Promise<unknown>;
};

const panels: DiscussionPanelElement[] = [];

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.remove());
});

function mount(params: {
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange?: SessionDiscussionStateListener;
  canOpen?: boolean;
}): DiscussionPanelElement {
  const panel = document.createElement("openclaw-session-discussion") as DiscussionPanelElement;
  panel.sessionKey = "agent:main:first";
  panel.loadInfo = params.loadInfo;
  panel.openDiscussion = params.openDiscussion;
  panel.onStateChange = params.onStateChange ?? vi.fn();
  panel.canOpen = params.canOpen ?? true;
  document.body.append(panel);
  panels.push(panel);
  return panel;
}

describe("session discussion panel", () => {
  it("automatically opens an available discussion without a redundant header", async () => {
    const loadInfo = vi.fn<SessionDiscussionInfoLoader>().mockResolvedValue({
      state: "available",
    });
    const openDiscussion = vi.fn<SessionDiscussionOpener>().mockResolvedValue({
      state: "open",
      embedUrl: "https://discussion.example/embed/thread",
      openUrl: "https://discussion.example/thread",
    });
    const onStateChange = vi.fn<SessionDiscussionStateListener>();
    const panel = mount({ loadInfo, openDiscussion, onStateChange });

    await vi.waitFor(() => {
      expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
        "https://discussion.example/embed/thread",
      );
      expect(panel.querySelector("iframe")?.getAttribute("sandbox")).toBe(
        "allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts",
      );
    });
    expect(loadInfo).toHaveBeenCalledTimes(1);
    expect(openDiscussion).toHaveBeenCalledTimes(1);
    expect(openDiscussion).toHaveBeenCalledWith("agent:main:first");
    expect(onStateChange).toHaveBeenLastCalledWith(
      "agent:main:first",
      "open",
      "https://discussion.example/thread",
    );
    expect(panel.querySelector(".session-discussion__header")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
  });

  it("offers the valid open URL when a same-origin embed is rejected", async () => {
    const openUrl = "https://discussion.example/thread";
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: new URL("/embed/thread", window.location.origin).href,
        openUrl,
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(panel.textContent).toContain("This discussion cannot be embedded");
    });
    const external = panel.querySelector<HTMLAnchorElement>("a");
    expect(panel.querySelector("iframe")).toBeNull();
    expect(external?.textContent).toContain("Open discussion in a new tab");
    expect(external?.href).toBe(openUrl);
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener");
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
      expect(panel.textContent).toContain("Opening discussion");
    });
    expect(panel.querySelector("button")).toBeNull();
  });

  it("does not auto-open without operator write access", async () => {
    const openDiscussion = vi.fn<SessionDiscussionOpener>();
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({ state: "available" }),
      openDiscussion,
      canOpen: false,
    });

    await vi.waitFor(() => {
      expect(panel.textContent).toContain("Operator write access is required");
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
    await vi.waitFor(() => {
      expect(panel.textContent).toContain("Operator write access is required");
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
    expect(panel.textContent).not.toContain("Opening discussion");
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

  it("does not render non-HTTP discussion URLs", async () => {
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "javascript:alert(1)",
        openUrl: "data:text/html,unsafe",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(panel.textContent).toContain("cannot be embedded");
    });
    expect(panel.querySelector("iframe")).toBeNull();
    expect(panel.querySelector("a")).toBeNull();
  });
});
