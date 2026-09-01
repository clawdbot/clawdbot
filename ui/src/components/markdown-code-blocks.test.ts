import { html, nothing, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMarkdownCodeBlockClick, markdownCodeBlocks } from "./markdown-code-blocks.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalExecCommand) {
    Object.defineProperty(document, "execCommand", originalExecCommand);
  } else {
    Reflect.deleteProperty(document, "execCommand");
  }
  document.body.innerHTML = "";
});

function renderCodeCopyButton(): HTMLButtonElement {
  document.body.innerHTML = toSanitizedMarkdownHtml("```ts\nconst answer = 42;\n```");
  const button = document.querySelector<HTMLButtonElement>(".code-block-copy");
  if (!button) {
    throw new Error("Expected Markdown code-copy button");
  }
  button.addEventListener("click", handleMarkdownCodeBlockClick);
  return button;
}

it("reobserves reused code DOM while fencing scans queued before disconnect", async () => {
  const observed = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const container = document.body.appendChild(document.createElement("div"));
  const content = toSanitizedMarkdownHtml("```ts\nconst answer = 42;\n```", {
    codeBlockInteraction: "interactive",
  });
  const part = render(
    html`<section ${markdownCodeBlocks()}>${unsafeHTML(content)}</section>`,
    container,
  );
  const code = container.querySelector("code");

  try {
    part.setConnected(false);
    await Promise.resolve();
    expect(observed.size).toBe(0);

    part.setConnected(true);
    await Promise.resolve();
    expect(observed.size).toBe(2);
    expect(observed.has(code!)).toBe(true);

    part.setConnected(false);
    expect(observed.size).toBe(0);
    part.setConnected(true);
    await Promise.resolve();
    expect(container.querySelector("code")).toBe(code);
    expect(observed.has(code!)).toBe(true);
    expect(observed.size).toBe(2);
  } finally {
    render(nothing, container);
  }
});

describe("Markdown code-block clipboard feedback", () => {
  it("visibly reports both denied clipboard paths and restores the idle state", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => {
      throw new DOMException("Clipboard access denied", "NotAllowedError");
    });
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.classList.contains("copied")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(button.classList.contains("copy-failed")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("preserves successful copy feedback and restores its accessible label", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(writeText).toHaveBeenCalledWith("const answer = 42;");
    expect(button.classList.contains("copied")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copied!");

    await vi.advanceTimersByTimeAsync(1_500);

    expect(button.classList.contains("copied")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("ignores an older clipboard attempt that finishes after the latest denied copy", async () => {
    vi.useFakeTimers();
    let resolveFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    const writeText = vi
      .fn()
      .mockReturnValueOnce(firstWrite)
      .mockRejectedValueOnce(new DOMException("Clipboard access denied", "NotAllowedError"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    resolveFirstWrite();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");
    expect(button.classList.contains("copied")).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it.each([
    { name: "a previous denied copy", firstSucceeds: false, firstResetAtMs: 2_000 },
    { name: "a previous successful copy", firstSucceeds: true, firstResetAtMs: 1_500 },
  ])("keeps the latest denied-copy feedback after $name", async (scenario) => {
    vi.useFakeTimers();
    const writeText = vi
      .fn()
      .mockRejectedValue(new DOMException("Clipboard access denied", "NotAllowedError"));
    if (scenario.firstSucceeds) {
      writeText.mockResolvedValueOnce(undefined);
    }
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const button = renderCodeCopyButton();

    button.click();
    await vi.advanceTimersByTimeAsync(1_000);
    button.click();
    await vi.advanceTimersByTimeAsync(scenario.firstResetAtMs - 1_000);

    expect(button.classList.contains("copy-failed")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Copy failed");

    await vi.advanceTimersByTimeAsync(3_000 - scenario.firstResetAtMs);

    expect(button.classList.contains("copy-failed")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Copy code");
  });

  it("keeps independent reset deadlines for different code-copy buttons", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new DOMException("Clipboard access denied")),
      },
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false,
    });
    const first = renderCodeCopyButton();
    const second = first.cloneNode(true) as HTMLButtonElement;
    second.addEventListener("click", handleMarkdownCodeBlockClick);
    document.body.append(second);

    first.click();
    await vi.advanceTimersByTimeAsync(500);
    second.click();
    await vi.advanceTimersByTimeAsync(1_500);

    expect(first.getAttribute("aria-label")).toBe("Copy code");
    expect(second.getAttribute("aria-label")).toBe("Copy failed");

    second.remove();
    await vi.advanceTimersByTimeAsync(500);

    expect(second.getAttribute("aria-label")).toBe("Copy code");
  });
});
