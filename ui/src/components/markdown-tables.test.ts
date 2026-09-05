/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startNativeLinkRouting } from "../app/native-link-routing.ts";
import { resetTranscriptSession } from "../pages/chat/components/chat-thread-interactions.ts";
import { installDialogPolyfill, waitForRenderedModalDialog } from "../test-helpers/modal-dialog.ts";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const writeText = vi.fn(async (_text: string) => undefined);

let clipboardDescriptor: PropertyDescriptor | undefined;
let mutationObserverDescriptor: PropertyDescriptor | undefined;
let resizeObserverDescriptor: PropertyDescriptor | undefined;
let restoreDialogPolyfill: () => void;

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
    return;
  }
  Reflect.deleteProperty(target, key);
}

const markdown = `Open agent:main:dashboard:table

<progress value="3" max="7"></progress>

| Name | Value |
| --- | --- |
| Alpha | One |`;

class TestMutationObserver {
  static instances: TestMutationObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(readonly callback: MutationCallback) {
    TestMutationObserver.instances.push(this);
  }
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}

function interactiveOwner(content = markdown): {
  owner: HTMLElement;
  shell: HTMLElement;
  viewport: HTMLElement;
} {
  const owner = document.createElement("div");
  owner.className = "chat-thread";
  owner.innerHTML = `<div class="chat-text">${toSanitizedMarkdownHtml(content, {
    progressBars: true,
    sessionLinks: true,
    tableInteractions: "enabled",
  })}</div>`;
  document.body.append(owner);
  const shell = owner.querySelector<HTMLElement>(".markdown-table")!;
  const viewport = owner.querySelector<HTMLElement>(".markdown-table__viewport")!;
  Object.defineProperties(viewport, {
    clientWidth: { configurable: true, value: 100 },
    scrollLeft: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 300 },
  });
  owner.addEventListener("click", handleMarkdownTableInteraction);
  enhanceMarkdownTables(owner);
  return { owner, shell, viewport };
}

describe("Markdown table interactions", () => {
  beforeEach(() => {
    TestMutationObserver.instances = [];
    TestResizeObserver.instances = [];
    clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    mutationObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
    resizeObserverDescriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    restoreDialogPolyfill = installDialogPolyfill();
    Object.defineProperty(globalThis, "MutationObserver", {
      configurable: true,
      writable: true,
      value: TestMutationObserver,
    });
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    });
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    restoreProperty(navigator, "clipboard", clipboardDescriptor);
    restoreProperty(globalThis, "MutationObserver", mutationObserverDescriptor);
    restoreProperty(globalThis, "ResizeObserver", resizeObserverDescriptor);
    restoreDialogPolyfill();
  });

  it("composes table chrome with session links and progress markup", () => {
    const disabled = toSanitizedMarkdownHtml(markdown, {
      progressBars: true,
      sessionLinks: true,
    });
    const enabled = toSanitizedMarkdownHtml(markdown, {
      progressBars: true,
      sessionLinks: true,
      tableInteractions: "enabled",
    });

    expect(disabled).not.toContain("data-table-interactions");
    expect(enabled).toContain("data-table-interactions");
    expect(enabled).toContain('data-session-key="agent:main:dashboard:table"');
    expect(enabled).toContain('<progress value="3" max="7"></progress>');
  });

  it("tracks hidden columns in both scroll directions", () => {
    const { shell, viewport } = interactiveOwner();

    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(false);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(true);

    viewport.scrollLeft = 100;
    viewport.dispatchEvent(new Event("scroll"));
    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(true);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(true);

    viewport.scrollLeft = 200;
    viewport.dispatchEvent(new Event("scroll"));
    expect(shell.classList.contains("markdown-table--can-scroll-left")).toBe(true);
    expect(shell.classList.contains("markdown-table--can-scroll-right")).toBe(false);
  });

  it("copies TSV and updates the copy label", async () => {
    vi.useFakeTimers();
    const { owner } = interactiveOwner();
    const copy = owner.querySelector<HTMLButtonElement>(".markdown-table__copy")!;
    copy.click();

    expect(writeText).toHaveBeenCalledWith("Name\tValue\nAlpha\tOne");
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.getAttribute("aria-label")).toBe("Copied!");
    expect(copy.querySelector("svg path")?.getAttribute("d")).toBe("M20 6 9 17l-5-5");
    await vi.advanceTimersByTimeAsync(1500);
    expect(copy.getAttribute("aria-label")).toBe("Copy table");
    expect(copy.querySelector("svg rect")).not.toBeNull();
  });

  it("restores focus after the table dialog closes", async () => {
    const { owner } = interactiveOwner();
    const expand = owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!;
    expand.focus();
    expand.click();
    expand.click();

    const { dialog, modal } = await waitForRenderedModalDialog(owner);
    expect(owner.querySelectorAll(".markdown-table-modal")).toHaveLength(1);
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(modal.querySelector("table")?.textContent).toContain("Alpha");
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);

    expand.click();
    const reopened = await waitForRenderedModalDialog(owner);
    reopened.modal.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("cancels a pending expansion when its owner disconnects and reconnects", async () => {
    const { owner } = interactiveOwner(
      `${markdown}\n\n| Updated | Value |\n| --- | --- |\n| Beta | Two |`,
    );
    const [first, second] = owner.querySelectorAll<HTMLButtonElement>(".markdown-table__expand");
    first!.click();

    releaseMarkdownTables(owner);
    owner.remove();
    document.body.append(owner);
    enhanceMarkdownTables(owner);
    second!.focus();
    second!.click();

    const { modal } = await waitForRenderedModalDialog(owner);
    expect(owner.querySelectorAll(".markdown-table-modal")).toHaveLength(1);
    expect(modal.querySelector("table")?.textContent).toContain("Beta");
    modal.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
    expect(document.activeElement).toBe(second);
  });

  it.each([true, false])(
    "dismisses middle-clicks while preserving right-click menus (browser panel: %s)",
    async (openInBrowserPanel) => {
      const routing = startNativeLinkRouting({
        shouldOpenInControlUiBrowser: () => openInBrowserPanel,
      });
      const { owner } = interactiveOwner(
        "| Reference |\n| --- |\n| [Open reference](https://example.com/table) |",
      );
      try {
        owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
        const { modal } = await waitForRenderedModalDialog(owner);
        const link = modal.querySelector("a")!;
        vi.useFakeTimers();
        for (const type of ["contextmenu", "auxclick"]) {
          const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 2 });
          link.dispatchEvent(event);
          await vi.advanceTimersByTimeAsync(0);
          expect(event.defaultPrevented).toBe(false);
          expect(modal.isConnected).toBe(true);
        }
        const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
        link.dispatchEvent(middle);
        expect(middle.defaultPrevented).toBe(openInBrowserPanel);
        await vi.advanceTimersByTimeAsync(0);
        expect(modal.isConnected).toBe(false);
      } finally {
        routing.dispose();
        releaseMarkdownTables(owner);
      }
    },
  );

  it("retires a connected pane's pending table without blocking another pane", async () => {
    const pane = document.createElement("section");
    const { owner } = interactiveOwner();
    pane.append(owner);
    document.body.append(pane);
    owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();

    resetTranscriptSession("retired-pane", pane);
    await vi.dynamicImportSettled();
    expect(owner.isConnected).toBe(true);
    expect(owner.querySelector(".markdown-table-modal")).toBeNull();

    const { owner: current } = interactiveOwner();
    current.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
    const { modal } = await waitForRenderedModalDialog(current);
    expect(modal.querySelector("table")?.textContent).toContain("Alpha");
    releaseMarkdownTables(current);
  });

  it("disconnects observers and removes the dialog with its transcript owner", async () => {
    const { owner } = interactiveOwner();
    const mutation = TestMutationObserver.instances.at(-1)!;
    const resize = TestResizeObserver.instances.at(-1)!;
    owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!.click();
    const { dialog } = await waitForRenderedModalDialog(owner);

    releaseMarkdownTables(owner);
    owner.remove();

    expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(resize.disconnect).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(false);
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
  });
});
