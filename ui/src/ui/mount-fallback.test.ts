import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const indexHtmlPath = path.resolve(process.cwd(), "ui/index.html");
type TestWindow = Window & typeof globalThis;

async function readIndexHtmlWithDelay(delayMs: number): Promise<string> {
  const html = await readFile(indexHtmlPath, "utf8");
  return html.replace(
    'data-openclaw-mount-timeout-ms="12000"',
    `data-openclaw-mount-timeout-ms="${delayMs}"`,
  );
}

function waitForWindowTimeout(window: TestWindow, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function createIsolatedWindow(): TestWindow {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const frameWindow = frame.contentWindow as TestWindow | null;
  if (!frameWindow) {
    throw new Error("failed to create isolated frame window");
  }
  return frameWindow;
}

function installFallbackShell(window: TestWindow, html: string): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const sentinel = Array.from(parsed.querySelectorAll<HTMLScriptElement>("script:not([src])")).find(
    (script) => script.textContent?.includes("openclaw-mount-fallback"),
  );
  if (!sentinel?.textContent) {
    throw new Error("Expected inline mount fallback script in index.html");
  }
  window.eval(sentinel.textContent);
}

function requireElementById<T extends HTMLElement>(
  window: TestWindow,
  id: string,
  constructor: new () => T,
): T {
  const element = window.document.getElementById(id);
  expect(element).toBeInstanceOf(constructor);
  if (!(element instanceof constructor)) {
    throw new Error(`Expected #${id}`);
  }
  return element;
}

describe("Control UI mount fallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the static troubleshooting panel when the app element is never registered", async () => {
    const frameWindow = createIsolatedWindow();
    expect(frameWindow.customElements.get("openclaw-app")).toBeUndefined();
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 10);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);
    expect([...frameWindow.document.body.classList]).toEqual(["openclaw-mount-fallback-active"]);
    expect(fallback.querySelector("h1")?.textContent?.trim()).toBe("Control UI did not start");
    expect(fallback.querySelector("a")?.textContent?.trim()).toBe("Control UI troubleshooting");
    expect(frameWindow.document.activeElement).toBeInstanceOf(frameWindow.HTMLElement);
    expect([...(frameWindow.document.activeElement as HTMLElement).classList]).toEqual([
      "mount-fallback__panel",
    ]);

    const waitButton = requireElementById(
      frameWindow,
      "openclaw-mount-wait",
      frameWindow.HTMLButtonElement,
    );
    waitButton.click();
    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);

    await waitForWindowTimeout(frameWindow, 10);
    expect(fallback.hidden).toBe(false);
  });

  it("keeps the fallback hidden when the app element registers before the timeout", async () => {
    const frameWindow = createIsolatedWindow();
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(25));
    if (!frameWindow.customElements.get("openclaw-app")) {
      frameWindow.customElements.define("openclaw-app", class extends frameWindow.HTMLElement {});
    }
    await frameWindow.customElements.whenDefined("openclaw-app");
    await waitForWindowTimeout(frameWindow, 35);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);
  });
});
