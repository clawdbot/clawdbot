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

    const empty = await vi.waitFor(() => {
      const candidate = panel.querySelector("openclaw-panel-empty-state");
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await empty.updateComplete;
    expect(empty.shadowRoot?.textContent).toContain("This discussion cannot be embedded");
    const external = panel.querySelector<HTMLAnchorElement>("a");
    expect(panel.querySelector("iframe")).toBeNull();
    expect(external?.textContent).toContain("Open discussion in a new tab");
    expect(external?.href).toBe(openUrl);
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener");
  });
});
