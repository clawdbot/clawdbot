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

describe("Control UI mount fallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the static troubleshooting panel when the app element is never registered", async () => {
    const frameWindow = createIsolatedWindow();
    expect(frameWindow.customElements.get("openclaw-app")).toBeUndefined();
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    await waitForWindowTimeout(frameWindow, 10);

    const fallback = frameWindow.document.getElementById("openclaw-mount-fallback");
    expect(fallback?.hidden).toBe(false);
    expect(frameWindow.document.body.classList.contains("openclaw-mount-fallback-active")).toBe(
      true,
    );
    expect(fallback?.textContent).toContain("Control UI did not start");
    expect(fallback?.textContent).toContain("Control UI troubleshooting");
    expect(frameWindow.document.activeElement?.classList.contains("mount-fallback__panel")).toBe(
      true,
    );

    const waitButton = frameWindow.document.getElementById("openclaw-mount-wait");
    waitButton?.click();
    expect(fallback?.hidden).toBe(true);
    expect(frameWindow.document.body.classList.contains("openclaw-mount-fallback-active")).toBe(
      false,
    );

    await waitForWindowTimeout(frameWindow, 10);
    expect(fallback?.hidden).toBe(false);
  });

  it("keeps the fallback hidden when the app element registers before the timeout", async () => {
    const frameWindow = createIsolatedWindow();
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(25));
    if (!frameWindow.customElements.get("openclaw-app")) {
      frameWindow.customElements.define("openclaw-app", class extends frameWindow.HTMLElement {});
    }
    await frameWindow.customElements.whenDefined("openclaw-app");
    await waitForWindowTimeout(frameWindow, 35);

    const fallback = frameWindow.document.getElementById("openclaw-mount-fallback");
    expect(fallback?.hidden).toBe(true);
    expect(frameWindow.document.body.classList.contains("openclaw-mount-fallback-active")).toBe(
      false,
    );
  });
});
