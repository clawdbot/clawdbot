// Control UI tests cover the display-mode cursor policy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeCursorPolicy = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

// What `DashboardWindowController.installNativeChromeScript` stamps on <html>.
const NATIVE_HOST_MARKERS = ["openclaw-native-macos", "openclaw-native-web-chrome"] as const;

type CursorCase = {
  /**
   * Expected cursor in an installed/app window: a `display-mode: standalone`
   * window, or a native app host that stamps `NATIVE_HOST_MARKERS` instead.
   */
  readonly appWindow: string;
  /** Expected cursor in an ordinary tab (`display-mode: browser`). */
  readonly browserTab: string;
  readonly selector: string;
};

const CURSOR_CASES: readonly CursorCase[] = [
  // Actionable controls follow the window they run in.
  { appWindow: "default", browserTab: "pointer", selector: ".btn" },
  { appWindow: "default", browserTab: "pointer", selector: "#plain-summary" },
  { appWindow: "default", browserTab: "pointer", selector: "#plain-select" },
  { appWindow: "default", browserTab: "pointer", selector: "#plain-checkbox" },
  { appWindow: "default", browserTab: "pointer", selector: "#role-button" },
  { appWindow: "default", browserTab: "pointer", selector: ".nav-item" },
  { appWindow: "default", browserTab: "pointer", selector: ".settings-secret__toggle" },
  // Real links keep the hand in both windows: a[href] through the UA, the
  // href-less content link through its own documented rule.
  { appWindow: "pointer", browserTab: "pointer", selector: "#real-link" },
  { appWindow: "pointer", browserTab: "pointer", selector: ".markdown-file-link" },
  // Semantic cursors belong to their component and never follow the policy.
  { appWindow: "text", browserTab: "text", selector: "#plain-text-input" },
  { appWindow: "text", browserTab: "text", selector: ".chat-pane__session-title-button" },
  { appWindow: "grab", browserTab: "grab", selector: ".sidebar-session-group-drag-handle" },
  { appWindow: "col-resize", browserTab: "col-resize", selector: ".sw-queue-resizer" },
  { appWindow: "zoom-in", browserTab: "zoom-in", selector: ".chat-message-image-button" },
  { appWindow: "not-allowed", browserTab: "not-allowed", selector: ".btn--ghost:disabled" },
  { appWindow: "wait", browserTab: "wait", selector: ".sidebar-update-card__hold:disabled" },
  // Deliberate `default` on non-actionable elements survives in both windows.
  { appWindow: "default", browserTab: "default", selector: ".session-tokens" },
  { appWindow: "default", browserTab: "default", selector: ".agent-tools-runtime-chip--more" },
];

function readUiCss(): string {
  return [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/layout.css",
    "ui/src/styles/sessions.css",
    "ui/src/styles/settings-controls.css",
    "ui/src/styles/settings.css",
    "ui/src/styles/skill-workshop.css",
    "ui/src/styles/chat/layout.css",
    "ui/src/styles/chat/split-view.css",
    "ui/src/styles/chat/text.css",
  ]
    .map((file) => readStyleSheet(file))
    .join("\n");
}

function fixtureDocument(): string {
  return `<!doctype html><html data-theme-mode="light"><head><style>${readUiCss()}</style></head><body>
    <main>
      <button class="btn" type="button">Primary</button>
      <button class="btn btn--ghost" type="button" disabled>Ghost disabled</button>
      <details><summary id="plain-summary">Details</summary><p>body</p></details>
      <select id="plain-select"><option>option</option></select>
      <input id="plain-checkbox" type="checkbox" />
      <input id="plain-text-input" type="text" value="text" />
      <div id="role-button" role="button" tabindex="0">Role button</div>
      <a id="real-link" href="https://example.com">Real link</a>
      <a class="nav-item" href="#/chat">Nav rail</a>
      <button class="settings-secret__toggle" type="button">Reveal</button>
      <button class="sidebar-update-card__hold" type="button" disabled>Hold</button>
      <button class="chat-pane__session-title-button" type="button">Session title</button>
      <button class="chat-message-image-button" type="button">Image</button>
      <div class="sidebar-session-group-drag-handle"></div>
      <div class="sw-queue-resizer"></div>
      <div class="session-tokens"><span class="session-tokens__value">12k</span></div>
      <span class="agent-tools-runtime-chip--more">+3</span>
      <div class="chat-text"><a class="markdown-file-link">src/index.ts</a></div>
    </main>
  </body></html>`;
}

type WindowProbe = {
  readonly cursors: Record<string, string>;
  readonly displayMode: string;
};

async function probeWindow(page: Page): Promise<WindowProbe> {
  return await page.evaluate(
    (selectors: readonly string[]) => {
      const modes = [
        "browser",
        "standalone",
        "minimal-ui",
        "window-controls-overlay",
        "fullscreen",
      ];
      const cursors = selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          throw new Error(`Missing cursor fixture element for ${selector}`);
        }
        return [selector, getComputedStyle(element).cursor] as const;
      });
      return {
        cursors: Object.fromEntries(cursors),
        displayMode:
          modes.find((mode) => matchMedia(`(display-mode: ${mode})`).matches) ?? "unknown",
      };
    },
    CURSOR_CASES.map((cursorCase) => cursorCase.selector),
  );
}

function expectedCursors(key: "appWindow" | "browserTab"): Record<string, string> {
  return Object.fromEntries(
    CURSOR_CASES.map((cursorCase) => [cursorCase.selector, cursorCase[key]]),
  );
}

let fixtureDirectory: string;
let fixtureFile: string;
let tabBrowser: Browser;
let appContext: BrowserContext;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-policy-"));
  fixtureFile = path.join(fixtureDirectory, "fixture.html");
  fs.writeFileSync(fixtureFile, fixtureDocument(), "utf8");
  tabBrowser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  try {
    // `--app=` opens a real Chromium app window, which is the only way to get a
    // genuine `display-mode: standalone` match; CDP media emulation does not
    // drive this feature.
    appContext = await chromium.launchPersistentContext(path.join(fixtureDirectory, "profile"), {
      args: [`--app=file://${fixtureFile}`],
      executablePath: chromiumExecutablePath,
      headless: true,
    });
  } catch (error) {
    await tabBrowser.close().catch(() => {});
    throw error;
  }
});

afterAll(async () => {
  await appContext?.close().catch(() => {});
  await tabBrowser?.close().catch(() => {});
  if (fixtureDirectory) {
    fs.rmSync(fixtureDirectory, { force: true, recursive: true });
  }
});

describeCursorPolicy("Control UI cursor policy", () => {
  it("advertises actionable controls with the hand in a browser tab", async () => {
    const page = await tabBrowser.newPage();
    try {
      await page.goto(`file://${fixtureFile}`);
      const probe = await probeWindow(page);

      expect(probe.displayMode).toBe("browser");
      expect(probe.cursors).toEqual(expectedCursors("browserTab"));
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("keeps the desktop arrow on app chrome in a native app host", async () => {
    const page = await tabBrowser.newPage();
    try {
      await page.goto(`file://${fixtureFile}`);
      // The macOS dashboard is a plain web view, so it reports display-mode
      // browser and marks itself with these classes at document end instead.
      await page.evaluate((markers: readonly string[]) => {
        document.documentElement.classList.add(...markers);
      }, NATIVE_HOST_MARKERS);
      const probe = await probeWindow(page);

      expect(probe.displayMode).toBe("browser");
      expect(probe.cursors).toEqual(expectedCursors("appWindow"));
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("keeps the desktop arrow on app chrome in an installed window", async () => {
    const [page] = appContext.pages();
    expect(page, "Chromium --app window did not expose a page").toBeDefined();
    await page!.waitForLoadState("load");
    const probe = await probeWindow(page!);

    expect(probe.displayMode).toBe("standalone");
    expect(probe.cursors).toEqual(expectedCursors("appWindow"));
  });
});
