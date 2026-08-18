/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const writeText = vi.fn(async (_text: string) => undefined);

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

function interactiveOwner(): {
  owner: HTMLElement;
  shell: HTMLElement;
  viewport: HTMLElement;
} {
  const owner = document.createElement("div");
  owner.className = "chat-thread";
  owner.innerHTML = `<div class="chat-text">${toSanitizedMarkdownHtml(markdown, {
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
    vi.stubGlobal("MutationObserver", TestMutationObserver);
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      }),
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute("open");
        this.dispatchEvent(new Event("close"));
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
    document.body.replaceChildren();
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

  it("copies TSV and restores focus after the table dialog closes", async () => {
    vi.useFakeTimers();
    const { owner } = interactiveOwner();
    const copy = owner.querySelector<HTMLButtonElement>(".markdown-table__copy")!;
    copy.click();
    expect(writeText).toHaveBeenCalledWith("Name\tValue\nAlpha\tOne");
    await vi.advanceTimersByTimeAsync(0);
    expect(copy.getAttribute("aria-label")).toBe("Copied!");

    const expand = owner.querySelector<HTMLButtonElement>(".markdown-table__expand")!;
    expand.focus();
    expand.click();
    const dialog = document.querySelector<HTMLDialogElement>(".markdown-table-dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    expect(dialog.querySelector("table")?.textContent).toContain("Alpha");

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      bottom: 500,
      height: 400,
      left: 100,
      right: 500,
      top: 100,
      width: 400,
      x: 100,
      y: 100,
      toJSON: () => ({}),
    });
    dialog.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 50, clientY: 50 }));
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);

    expand.click();
    const reopenedDialog = document.querySelector<HTMLDialogElement>(".markdown-table-dialog")!;

    reopenedDialog.querySelector<HTMLButtonElement>(".markdown-table-dialog__close")!.click();
    expect(document.querySelector(".markdown-table-dialog")).toBeNull();
    expect(document.activeElement).toBe(expand);
  });

  it("disconnects observers when the transcript owner is released", () => {
    const { owner } = interactiveOwner();
    const mutation = TestMutationObserver.instances.at(-1)!;
    const resize = TestResizeObserver.instances.at(-1)!;

    releaseMarkdownTables(owner);

    expect(mutation.disconnect).toHaveBeenCalledOnce();
    expect(resize.disconnect).toHaveBeenCalledOnce();
  });
});
