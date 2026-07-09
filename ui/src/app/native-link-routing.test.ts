/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../components/github-link-hovercard.ts";
import type { GitHubLinkHovercardProvider } from "../components/github-link-hovercard.ts";
import "../components/modal-dialog.ts";
import { startNativeLinkRouting, type NativeLinkRouting } from "./native-link-routing.ts";

type NativeMessage = { type: string; url: string; target: string };

let routing: NativeLinkRouting | undefined;

afterEach(() => {
  routing?.dispose();
  routing = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function installBridge() {
  const messages: NativeMessage[] = [];
  const postMessage = vi.fn((message: NativeMessage) => messages.push(message));
  vi.stubGlobal("webkit", { messageHandlers: { openclawLink: { postMessage } } });
  return { messages, postMessage };
}

function appendLink(href: string, attributes: Record<string, string> = {}) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = href;
  for (const [name, value] of Object.entries(attributes)) {
    anchor.setAttribute(name, value);
  }
  document.body.append(anchor);
  return anchor;
}

function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}) {
  const event = new MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    ...init,
  });
  anchor.dispatchEvent(event);
  return event;
}

function contextMenu(anchor: HTMLAnchorElement) {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 2,
    clientX: 120,
    clientY: 140,
  });
  anchor.dispatchEvent(event);
  return event;
}

function menuItem(label: string): HTMLButtonElement {
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!item) {
    throw new Error(`Expected menu item: ${label}`);
  }
  return item;
}

describe("native link routing", () => {
  it("does not install native behavior without the WebKit bridge", () => {
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report");

    const event = contextMenu(anchor);

    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
  });

  it("routes an unmodified external click inline and preserves page-level cleanup", () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report");
    const bubbleHandler = vi.fn();
    anchor.addEventListener("click", bubbleHandler);

    const event = click(anchor);

    expect(event.defaultPrevented).toBe(true);
    expect(bubbleHandler).toHaveBeenCalledOnce();
    expect(bridge.messages).toEqual([
      { type: "open-link", url: "https://example.com/report", target: "inline" },
    ]);
  });

  it("closes an active GitHub hovercard after routing its link", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const provider = document.createElement(
      "openclaw-github-link-hovercard-provider",
    ) as GitHubLinkHovercardProvider;
    provider.client = {
      request: vi.fn().mockResolvedValue({
        comments: 1,
        createdAt: "2026-07-09T10:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 102691,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        title: "Open links in a sidebar browser",
        updatedAt: "2026-07-09T10:00:00Z",
      }),
    } as unknown as GatewayBrowserClient;
    const anchor = document.createElement("a");
    anchor.href = "https://github.com/openclaw/openclaw/issues/102691";
    anchor.textContent = "#102691";
    provider.append(anchor);
    document.body.append(provider);
    anchor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(document.querySelector(".github-link-hovercard")).not.toBeNull());

    click(anchor);

    expect(document.querySelector(".github-link-hovercard")).toBeNull();
    expect(anchor.hasAttribute("aria-describedby")).toBe(false);
    expect(bridge.messages).toEqual([
      {
        type: "open-link",
        url: "https://github.com/openclaw/openclaw/issues/102691",
        target: "inline",
      },
    ]);
  });

  it("preserves modifiers, local/file/download links, and non-web schemes", () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const links = [
      appendLink(`${location.origin}/usage`),
      appendLink("https://example.com/file", { "data-file-path": "README.md" }),
      appendLink("https://example.com/archive.zip", { download: "archive.zip" }),
      appendLink("mailto:hello@example.com"),
    ];
    for (const anchor of links) {
      anchor.addEventListener("click", (event) => event.preventDefault());
      click(anchor);
    }
    const modified = appendLink("https://example.com/modified");
    const bubbleHandler = vi.fn((event: Event) => event.preventDefault());
    modified.addEventListener("click", bubbleHandler);
    click(modified, { metaKey: true });

    expect(bubbleHandler).toHaveBeenCalledOnce();
    expect(bridge.messages).toEqual([]);
  });

  it("offers inline, external, and copy actions for an external link", async () => {
    const bridge = installBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } } as unknown as Navigator);
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report?q=1");

    expect(contextMenu(anchor).defaultPrevented).toBe(true);
    const firstMenu = document.querySelector("openclaw-native-link-menu");
    await (firstMenu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(
      [...firstMenu!.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim()),
    ).toEqual(["Open in Sidebar", "Open in Default Browser", "Copy Link"]);
    menuItem("Open in Default Browser").click();
    expect(bridge.messages.at(-1)).toEqual({
      type: "open-link",
      url: "https://example.com/report?q=1",
      target: "external",
    });

    contextMenu(anchor);
    const secondMenu = document.querySelector("openclaw-native-link-menu");
    await (secondMenu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    menuItem("Copy Link").click();
    await vi.waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://example.com/report?q=1"),
    );
  });

  it("mounts a fallback menu inside an active dialog", async () => {
    installBridge();
    routing = startNativeLinkRouting();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/dialog-link";
    dialog.append(anchor);
    document.body.append(dialog);

    contextMenu(anchor);

    const menu = dialog.querySelector("openclaw-native-link-menu");
    expect(menu).not.toBeNull();
    await (menu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(menuItem("Open in Sidebar")).not.toBeNull();
  });

  it("keeps modal menus in the styled light-DOM slot", async () => {
    installBridge();
    routing = startNativeLinkRouting();
    const modal = document.createElement("openclaw-modal-dialog");
    const anchor = document.createElement("a");
    anchor.href = "https://example.com/modal-link";
    modal.append(anchor);
    document.body.append(modal);
    await (modal as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;

    contextMenu(anchor);

    const menu = modal.querySelector("openclaw-native-link-menu");
    expect(menu).not.toBeNull();
    expect(menu?.getRootNode()).toBe(document);
    await (menu as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete;
    expect(menuItem("Open in Sidebar")).not.toBeNull();
  });

  it("removes listeners and an open menu on dispose", async () => {
    const bridge = installBridge();
    routing = startNativeLinkRouting();
    const anchor = appendLink("https://example.com/report");
    contextMenu(anchor);
    expect(document.querySelector("openclaw-native-link-menu")).not.toBeNull();

    routing.dispose();
    routing = undefined;
    anchor.addEventListener("click", (event) => event.preventDefault());
    click(anchor);

    expect(document.querySelector("openclaw-native-link-menu")).toBeNull();
    expect(bridge.messages).toEqual([]);
  });
});
