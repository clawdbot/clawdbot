/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionDiscussionPanelConfig } from "./session-discussion-panel.ts";
import "./session-discussion-panel.ts";

type SessionDiscussionInfoLoader = SessionDiscussionPanelConfig["loadInfo"];
type SessionDiscussionOpener = SessionDiscussionPanelConfig["openDiscussion"];
type SessionDiscussionStateListener = SessionDiscussionPanelConfig["onStateChange"];

type DiscussionPanelElement = HTMLElement & {
  sessionKey: string;
  canOpen: boolean;
  sourceGeneration: number;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange: SessionDiscussionStateListener;
  updateComplete: Promise<unknown>;
};

const panels: DiscussionPanelElement[] = [];

afterEach(() => {
  panels.splice(0).forEach((panel) => panel.remove());
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

function expectedEmbedUrl(url: string, mode: "light" | "dark" = "dark"): string {
  const resolved = new URL(url);
  if (
    resolved.searchParams.get("openclawHostTheme") !== "1" ||
    !/^\/embed\/(?:channel|thread)\/[^/]+\/[^/]+\/?$/u.test(resolved.pathname)
  ) {
    return resolved.href;
  }
  resolved.searchParams.set("theme", mode);
  resolved.searchParams.set("hostOrigin", window.location.origin);
  return resolved.href;
}

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
        expectedEmbedUrl("https://discussion.example/embed/thread"),
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

  it("selects the host color mode before the discussion frame paints", async () => {
    document.documentElement.dataset.themeMode = "light";
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl:
          "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1&existing=1#messages",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(panel.querySelector("iframe")?.getAttribute("src")).toBe(
        expectedEmbedUrl(
          "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1&existing=1#messages",
          "light",
        ),
      );
    });
  });

  it("preserves signed provider URLs even when their routes resemble ClickClack", async () => {
    const signedUrl =
      "https://discussion.example/embed/channel/a/b?signature=abc%2B123&expires=1785200000#thread";
    document.documentElement.dataset.themeMode = "light";
    document.documentElement.style.setProperty("--bg", "#faf9f7");
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: signedUrl,
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => {
      expect(panel.querySelector<HTMLIFrameElement>("iframe")?.src).toBe(signedUrl);
    });
    const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    frame.dispatchEvent(new Event("load"));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openclaw:widget-theme",
        tokens: expect.objectContaining({ surface: "#faf9f7" }),
      }),
      "https://discussion.example",
    );
  });

  it("posts the complete host palette to the exact discussion origin on frame load", async () => {
    document.documentElement.dataset.themeMode = "light";
    document.documentElement.style.setProperty("--bg", "#faf9f7");
    document.documentElement.style.setProperty("--card", "#ffffff");
    document.documentElement.style.setProperty("--accent", "#bd4531");
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    frame.dispatchEvent(new Event("load"));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openclaw:widget-theme",
        mode: "light",
        tokens: expect.objectContaining({
          surface: "#faf9f7",
          card: "#ffffff",
          accent: "#bd4531",
        }),
      }),
      "https://discussion.example",
    );
  });

  it("includes custom host palette tokens in the first-paint discussion URL", async () => {
    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.setProperty("--bg", "#171229");
    document.documentElement.style.setProperty("--card", "#211a36");
    document.documentElement.style.setProperty("--accent", "#c084fc");
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const embedUrl = new URL(panel.querySelector<HTMLIFrameElement>("iframe")!.src);

    expect(embedUrl.searchParams.get("theme")).toBe("dark");
    expect(JSON.parse(embedUrl.searchParams.get("themeTokens")!)).toEqual(
      expect.objectContaining({
        surface: "#171229",
        card: "#211a36",
        accent: "#c084fc",
      }),
    );
  });

  it("updates an existing discussion frame when the host theme changes", async () => {
    document.documentElement.dataset.themeMode = "light";
    document.documentElement.style.setProperty("--bg", "#faf9f7");
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
    const originalUrl = frame.src;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.setProperty("--bg", "#0e1015");

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "openclaw:widget-theme",
          mode: "dark",
          tokens: expect.objectContaining({ surface: "#0e1015" }),
        }),
        "https://discussion.example",
      );
    });
    expect(frame.src).toBe(originalUrl);
  });

  it("updates the discussion when only the custom host palette changes", async () => {
    document.documentElement.dataset.themeMode = "dark";
    document.documentElement.style.setProperty("--bg", "#171229");
    const panel = mount({
      loadInfo: vi.fn().mockResolvedValue({
        state: "open",
        embedUrl: "https://discussion.example/embed/channel/T1/C1?openclawHostTheme=1",
      }),
      openDiscussion: vi.fn(),
    });

    await vi.waitFor(() => expect(panel.querySelector("iframe")).not.toBeNull());
    const frame = panel.querySelector<HTMLIFrameElement>("iframe")!;
    const originalUrl = frame.src;
    const postMessage = vi.spyOn(frame.contentWindow!, "postMessage");

    document.documentElement.style.setProperty("--bg", "#211a36");

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "openclaw:widget-theme",
          mode: "dark",
          tokens: expect.objectContaining({ surface: "#211a36" }),
        }),
        "https://discussion.example",
      );
    });
    expect(frame.src).toBe(originalUrl);
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
