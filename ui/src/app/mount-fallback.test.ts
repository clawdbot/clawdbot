// Control UI tests cover mount fallback behavior.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
type TestWindow = Window & typeof globalThis;

async function readIndexHtml(): Promise<string> {
  return readFile(indexHtmlPath, "utf8");
}

async function readIndexHtmlWithDelay(delayMs: number): Promise<string> {
  const html = await readIndexHtml();
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

function installStartupPaintShell(window: TestWindow, html: string): void {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  window.document.head.innerHTML = parsed.head.innerHTML;
  window.document.body.innerHTML = parsed.body.innerHTML;

  const startupScript = Array.from(
    parsed.querySelectorAll<HTMLScriptElement>("script:not([src])"),
  ).find((script) => script.textContent?.includes("var THEMES = {"));
  if (!startupScript?.textContent) {
    throw new Error("Expected inline startup theme script in index.html");
  }
  window.eval(startupScript.textContent);
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

describe("Control UI document shell", () => {
  it("requests the web app manifest with credentials", async () => {
    const parsed = new DOMParser().parseFromString(await readIndexHtml(), "text/html");
    const manifest = parsed.querySelector<HTMLLinkElement>('link[rel="manifest"]');

    expect(manifest?.getAttribute("crossorigin")).toBe("use-credentials");
  });
});

describe("Control UI mount fallback", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["claw dark", { theme: "claw", themeMode: "dark" }, "dark", "rgb(14, 16, 21)"],
    ["OpenKnot dark", { theme: "knot", themeMode: "dark" }, "openknot", "rgb(8, 8, 8)"],
    ["Dash light", { theme: "dash", themeMode: "light" }, "dash-light", "rgb(247, 242, 236)"],
    [
      "Absolutely dark",
      { theme: "absolutely", themeMode: "dark" },
      "absolutely",
      "rgb(28, 28, 26)",
    ],
    [
      "Absolutely light",
      { theme: "absolutely", themeMode: "light" },
      "absolutely-light",
      "rgb(250, 249, 245)",
    ],
    ["Tide dark", { theme: "tide", themeMode: "dark" }, "tide", "rgb(16, 21, 27)"],
    ["Beacon dark", { theme: "beacon", themeMode: "dark" }, "beacon", "rgb(0, 0, 0)"],
    ["Beacon light", { theme: "beacon", themeMode: "light" }, "beacon-light", "rgb(255, 255, 255)"],
    ["Phosphor dark", { theme: "phosphor", themeMode: "dark" }, "phosphor", "rgb(10, 15, 10)"],
    ["CRT dark", { theme: "crt", themeMode: "dark" }, "crt", "rgb(9, 10, 9)"],
    ["CRT light", { theme: "crt", themeMode: "light" }, "crt-light", "rgb(245, 245, 244)"],
    [
      "Manuscript light",
      { theme: "manuscript", themeMode: "light" },
      "manuscript-light",
      "rgb(246, 241, 228)",
    ],
    [
      "Manuscript dark",
      { theme: "manuscript", themeMode: "dark" },
      "manuscript",
      "rgb(33, 30, 24)",
    ],
    ["Ros\u00e9 dark", { theme: "rose", themeMode: "dark" }, "rose", "rgb(25, 23, 36)"],
    ["Miami dark", { theme: "miami", themeMode: "dark" }, "miami", "rgb(20, 15, 30)"],
  ])(
    "paints %s before the app stylesheet loads",
    async (_name, settings, expectedTheme, expectedBackground) => {
      const frameWindow = createIsolatedWindow();
      frameWindow.localStorage.clear();
      frameWindow.localStorage.setItem("openclaw.control.settings.v1", JSON.stringify(settings));
      installStartupPaintShell(frameWindow, await readIndexHtmlWithDelay(1));

      expect(frameWindow.document.documentElement.dataset.theme).toBe(expectedTheme);
      expect(
        frameWindow.getComputedStyle(frameWindow.document.documentElement).backgroundColor,
      ).toBe(expectedBackground);
      expect(frameWindow.getComputedStyle(frameWindow.document.body).backgroundColor).toBe(
        expectedBackground,
      );
    },
  );

  it("shows the static troubleshooting panel when the app never renders", async () => {
    const frameWindow = createIsolatedWindow();
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

  it("keeps the fallback visible until the app completes its first render", async () => {
    const frameWindow = createIsolatedWindow();
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));
    if (!frameWindow.customElements.get("openclaw-app")) {
      frameWindow.customElements.define("openclaw-app", class extends frameWindow.HTMLElement {});
    }
    await frameWindow.customElements.whenDefined("openclaw-app");
    await waitForWindowTimeout(frameWindow, 10);

    const fallback = requireElementById(
      frameWindow,
      "openclaw-mount-fallback",
      frameWindow.HTMLElement,
    );
    expect(fallback.hidden).toBe(false);
    expect([...frameWindow.document.body.classList]).toEqual(["openclaw-mount-fallback-active"]);

    frameWindow.dispatchEvent(new frameWindow.Event("openclaw-control-ui-rendered"));

    expect(fallback.hidden).toBe(true);
    expect([...frameWindow.document.body.classList]).toEqual([]);
  });

  it("probes a cache-busted current document when the original bundle did not start", async () => {
    const frameWindow = createIsolatedWindow();
    const html = await readIndexHtmlWithDelay(1);
    const fetch = vi.fn().mockResolvedValue({ ok: false });
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, html);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("openclaw_mount_recovery="),
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(frameWindow.AbortSignal),
      }),
    );
  });

  it("times out stalled recovery probes so automatic retries can continue", async () => {
    const frameWindow = createIsolatedWindow();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (!(signal instanceof frameWindow.AbortSignal)) {
        throw new Error("Expected recovery probe to include an abort signal");
      }
      signals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    });
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));

    expect(signals).toHaveLength(6);
    await vi.waitFor(() => expect(signals.every((signal) => signal.aborted)).toBe(true));
  });

  it("bounds automatic recovery attempts while the gateway is unavailable", async () => {
    const frameWindow = createIsolatedWindow();
    const fetch = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const unregister = vi.fn().mockResolvedValue(true);
    const getRegistrations = vi.fn().mockResolvedValue([{ unregister }]);
    Object.defineProperty(frameWindow, "fetch", { configurable: true, value: fetch });
    Object.defineProperty(frameWindow.navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistrations },
    });
    installFallbackShell(frameWindow, await readIndexHtmlWithDelay(1));

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(6));
    await vi.waitFor(() => expect(unregister).toHaveBeenCalled());
    await waitForWindowTimeout(frameWindow, 10);

    expect(fetch).toHaveBeenCalledTimes(6);
    expect(getRegistrations).toHaveBeenCalled();
    expect(
      requireElementById(
        frameWindow,
        "openclaw-mount-fallback-summary",
        frameWindow.HTMLParagraphElement,
      ).textContent,
    ).toContain("gateway is still unavailable");
  });
});
