import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { renderMessageImages } from "../pages/chat/components/chat-message-images.ts";
import { renderMessageMarkdown } from "../pages/chat/components/chat-message-text.ts";
import { exportWidget } from "../pages/chat/components/widget-export.ts";
import "../pages/chat/components/browser-tab-card.ts";
import { renderCopyButton } from "./copy-button.ts";
import { handleMarkdownCodeBlockClick } from "./markdown-code-blocks.ts";
import "./markdown-mermaid.ts";
import { handleMarkdownTableInteraction, releaseMarkdownTables } from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const owners: HTMLElement[] = [];
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let clipboard = "original clipboard";
const writeText = vi.fn<(text: string) => Promise<void>>();
const fallbackCopies: string[] = [];

beforeEach(() => {
  clipboard = "original clipboard";
  fallbackCopies.length = 0;
  writeText.mockReset().mockImplementation(async (text) => {
    clipboard = text;
  });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  // Both transports stay inside this page; these tests never write the OS clipboard.
  vi.spyOn(document, "execCommand").mockImplementation(() => {
    const input = document.activeElement;
    if (!(input instanceof HTMLTextAreaElement)) {
      throw new Error("Clipboard fallback did not select its text");
    }
    clipboard = input.value;
    fallbackCopies.push(clipboard);
    return true;
  });
});

afterEach(() => {
  for (const owner of owners.splice(0)) {
    releaseMarkdownTables(owner);
    render(nothing, owner);
    owner.remove();
  }
  vi.restoreAllMocks();
  if (clipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

afterAll(() => {
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
});

async function waitForDiagram(diagram: HTMLElement) {
  const { page } = await import("vitest/browser");
  await expect.element(page.elementLocator(diagram).getByRole("img")).toBeVisible();
  await diagram.shadowRoot!.querySelector("img")!.decode();
}

async function mountCopy(surface: "code" | "table" | "mermaid" | "message") {
  const owner = document.body.appendChild(document.createElement("section"));
  owners.push(owner);
  owner.className = "chat-text";
  let button: HTMLButtonElement | null;
  if (surface === "code") {
    render(
      renderMessageMarkdown(
        "```ts\nconst answer = 42;",
        "stream",
        { role: "assistant", isStreaming: true },
        {},
      ),
      owner,
    );
    owner.addEventListener("click", handleMarkdownCodeBlockClick);
    button = owner.querySelector(".code-block-copy");
  } else if (surface === "table") {
    render(
      html`${unsafeHTML(toSanitizedMarkdownHtml("| Name |\n| --- |\n| Alpha |", { tableInteractions: "enabled" }))}`,
      owner,
    );
    owner.addEventListener("click", handleMarkdownTableInteraction);
    button = owner.querySelector(".markdown-table__copy");
  } else if (surface === "mermaid") {
    const diagram = document.createElement("openclaw-mermaid");
    diagram.source = "flowchart LR\nA --> B";
    owner.append(diagram);
    await diagram.updateComplete;
    await waitForDiagram(diagram);
    button = diagram.shadowRoot?.querySelector(".copy-button") ?? null;
  } else {
    render(renderCopyButton("Current message"), owner);
    button = owner.querySelector("button");
  }
  if (!button) {
    throw new Error(`Missing ${surface} copy control`);
  }
  return { owner, button };
}

function delayFirstWrite() {
  const pending = createDeferred();
  writeText.mockReturnValueOnce(pending.promise);
  return pending;
}

async function mountBrowserCard() {
  const card = document.createElement("openclaw-browser-tab-card");
  card.preview = {
    kind: "browser-tab",
    target: "host",
    profile: "managed",
    targetId: "clipboard-tab",
    url: "https://example.com/document",
  };
  document.body.append(card);
  owners.push(card);
  await card.updateComplete;
  return {
    card,
    copy: () =>
      card.shadowRoot
        ?.querySelector("wa-dropdown")
        ?.dispatchEvent(new CustomEvent("wa-select", { detail: { item: { value: "copy-url" } } })),
  };
}

async function flushCopy() {
  // Clipboard handlers update after the transport's rejection/fallback microtasks.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("Markdown clipboard operation lifetime", () => {
  it.each(
    ["managed image", "widget"].flatMap((surface) =>
      [true, false].map((available) => ({ surface, available })),
    ),
  )(
    "retires text fallback after $surface copy intent (binary API: $available)",
    async ({ surface, available }) => {
      const pendingText = delayFirstWrite();
      const pngData =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR7sAAAAASUVORK5CYII=";
      const nativeFetch = globalThis.fetch.bind(globalThis);
      const png = await (await nativeFetch(pngData)).blob();
      const snapshot = createDeferred<string>();
      const fullImage = createDeferred<Response>();
      const write = vi.fn(async (items: ClipboardItem[]) => {
        expect((await items[0]!.getType("image/png")).type).toBe("image/png");
        clipboard = "new binary image";
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText, ...(available ? { write } : {}) },
      });
      let copy: () => void;
      let widgetResult: Promise<unknown> | undefined;
      if (surface === "managed image") {
        vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          return url.includes("/thumbnail")
            ? Promise.resolve(new Response(png))
            : url.includes("/full")
              ? fullImage.promise
              : nativeFetch(input, init);
        });
        const owner = document.body.appendChild(document.createElement("section"));
        owners.push(owner);
        render(
          renderMessageImages([
            {
              url: `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`,
              alt: "Synthetic image",
            },
          ]),
          owner,
        );
        await vi.waitFor(() =>
          expect(owner.querySelector('[aria-label="Copy image"]')).not.toBeNull(),
        );
        copy = () => owner.querySelector<HTMLButtonElement>('[aria-label="Copy image"]')!.click();
      } else {
        const frame = document.body.appendChild(document.createElement("iframe"));
        owners.push(frame);
        copy = () => {
          widgetResult = exportWidget("copy", frame, "Synthetic widget", {
            requestSnapshot: () => snapshot.promise,
          }).catch((error: unknown) => error);
        };
      }
      const code = await mountCopy("code");
      code.button.click();
      copy();
      // Binary ClipboardItem promises must be submitted during the click, before bytes arrive.
      expect(write).toHaveBeenCalledTimes(available ? 1 : 0);
      pendingText.reject(new Error("Synthetic clipboard rejection"));
      await flushCopy();
      snapshot.resolve(pngData);
      fullImage.resolve(new Response(png));
      await widgetResult;
      if (available) {
        await vi.waitFor(() => expect(clipboard).toBe("new binary image"));
      }
      expect(fallbackCopies).toEqual([]);
    },
  );

  it("copies browser-card URLs when the Clipboard API is absent on plain HTTP", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const browser = await mountBrowserCard();
    browser.copy();
    await flushCopy();
    expect(clipboard).toBe("https://example.com/document");
    expect(fallbackCopies).toEqual(["https://example.com/document"]);
  });

  it("keeps a newer browser URL copy when older code copying rejects", async () => {
    const pending = delayFirstWrite();
    const code = await mountCopy("code");
    const browser = await mountBrowserCard();
    code.button.click();
    browser.copy();
    await flushCopy();
    expect(clipboard).toBe("https://example.com/document");
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(clipboard).toBe("https://example.com/document");
    expect(fallbackCopies).toEqual([]);
  });

  it.each(["removed", "URL changed"])(
    "retires browser URL copying after its card is %s",
    async (change) => {
      const pending = delayFirstWrite();
      const browser = await mountBrowserCard();
      browser.copy();
      if (change === "removed") {
        browser.card.remove();
      } else {
        browser.card.preview = { ...browser.card.preview!, url: "https://example.com/new" };
        await browser.card.updateComplete;
      }
      pending.reject(new Error("Synthetic clipboard rejection"));
      await flushCopy();
      expect(fallbackCopies).toEqual([]);
    },
  );

  it.each(["code", "table", "mermaid", "message"] as const)(
    "does not start fallback after the %s control is retired",
    async (surface) => {
      const pending = delayFirstWrite();
      const { owner, button } = await mountCopy(surface);
      button.click();
      expect(writeText).toHaveBeenCalledOnce();
      owner.remove();
      pending.reject(new Error("Synthetic clipboard rejection"));
      await flushCopy();
      expect(fallbackCopies).toEqual([]);
      expect(clipboard).toBe("original clipboard");
    },
  );

  it("preserves the newer copy when an older connected code control rejects", async () => {
    const pending = delayFirstWrite();
    const older = await mountCopy("code");
    const newer = await mountCopy("message");
    older.button.click();
    newer.button.click();
    await flushCopy();
    expect(clipboard).toBe("Current message");
    expect(older.button.isConnected).toBe(true);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(fallbackCopies).toEqual([]);
    expect(clipboard).toBe("Current message");
  });

  it("retires code replaced by the next streaming update", async () => {
    const pending = delayFirstWrite();
    const { owner, button } = await mountCopy("code");
    button.click();
    render(
      renderMessageMarkdown(
        "```ts\nconst answer = 42;\nconst next = 43;",
        "stream",
        { role: "assistant", isStreaming: true },
        {},
      ),
      owner,
    );
    expect(button.isConnected).toBe(false);
    expect(owner.querySelector("code")?.textContent).toContain("const next = 43;");
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(fallbackCopies).toEqual([]);
  });

  it("retires an older fallback when the newer code-copy payload is empty", async () => {
    const pending = delayFirstWrite();
    const older = await mountCopy("code");
    const newer = await mountCopy("code");
    render(
      renderMessageMarkdown("```ts\n```", "empty", { role: "assistant", isStreaming: false }, {}),
      newer.owner,
    );
    older.button.click();
    newer.owner.querySelector<HTMLButtonElement>(".code-block-copy")!.click();
    expect(writeText).toHaveBeenCalledOnce();
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(fallbackCopies).toEqual([]);
    expect(clipboard).toBe("original clipboard");
  });

  it("retires a Mermaid copy when its source changes on the connected element", async () => {
    const pending = delayFirstWrite();
    const { owner, button } = await mountCopy("mermaid");
    const diagram = owner.querySelector("openclaw-mermaid")!;
    button.click();
    diagram.source = "flowchart LR\nC --> D";
    await diagram.updateComplete;
    expect(diagram.isConnected).toBe(true);
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(fallbackCopies).toEqual([]);
    await waitForDiagram(diagram);
  });

  it("keeps the newer table-copy feedback when an older request rejects", async () => {
    const pending = delayFirstWrite();
    const { button } = await mountCopy("table");
    button.click();
    button.click();
    await flushCopy();
    expect(button.getAttribute("aria-label")).toBe("Copied!");
    pending.reject(new Error("Synthetic clipboard rejection"));
    await flushCopy();
    expect(fallbackCopies).toEqual([]);
    expect(button.getAttribute("aria-label")).toBe("Copied!");
  });

  it.each(["code", "table", "mermaid", "message"] as const)(
    "keeps fallback available for the current %s control",
    async (surface) => {
      writeText.mockRejectedValueOnce(new Error("Synthetic clipboard rejection"));
      const { button } = await mountCopy(surface);
      button.click();
      await flushCopy();
      expect(fallbackCopies).toEqual([writeText.mock.calls[0]![0]]);
      expect(button.getAttribute("aria-label")).toBe("Copied!");
    },
  );
});
