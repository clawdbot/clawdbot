// Control UI tests cover the semantic cursor policy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import { dockPanelStyles } from "../components/dock-layout-controller.ts";
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
  readonly expected: string;
  readonly selector: string;
  readonly shadow?: boolean;
};

const CURSOR_CASES: readonly CursorCase[] = [
  // State-changing controls use the desktop arrow in every host.
  { expected: "default", selector: ".btn" },
  { expected: "default", selector: "#plain-summary" },
  { expected: "default", selector: "#plain-select" },
  { expected: "default", selector: "#plain-checkbox" },
  { expected: "default", selector: "#role-button" },
  { expected: "default", selector: ".settings-secret__toggle" },
  // Links and explicit new-tab controls keep the hand.
  { expected: "pointer", selector: "#real-link" },
  { expected: "pointer", selector: ".nav-item" },
  { expected: "pointer", selector: "#new-tab-link" },
  { expected: "pointer", selector: "#new-tab-button" },
  { expected: "pointer", selector: "#shadow-new-tab-button", shadow: true },
  { expected: "pointer", selector: ".markdown-file-link" },
  // Semantic cursors remain owned by their components.
  { expected: "text", selector: "#plain-text-input" },
  { expected: "text", selector: ".chat-pane__session-title-button" },
  { expected: "grab", selector: ".sidebar-session-group-drag-handle" },
  { expected: "zoom-in", selector: ".chat-message-image-button" },
  { expected: "not-allowed", selector: ".btn--ghost:disabled" },
  { expected: "not-allowed", selector: "#disabled-new-tab-button" },
  { expected: "default", selector: "#shadow-disabled-new-tab-button", shadow: true },
  { expected: "wait", selector: ".sidebar-update-card__hold:disabled" },
  { expected: "default", selector: ".session-tokens" },
  { expected: "default", selector: ".agent-tools-runtime-chip--more" },
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
      <a id="new-tab-link" class="btn" href="https://example.com/docs" target="_blank">Docs</a>
      <button id="new-tab-button" class="btn" type="button" data-new-tab-action>New tab</button>
      <button id="disabled-new-tab-button" class="btn btn--ghost" type="button" data-new-tab-action disabled>Unavailable new tab</button>
      <button class="settings-secret__toggle" type="button">Reveal</button>
      <button class="sidebar-update-card__hold" type="button" disabled>Hold</button>
      <button class="chat-pane__session-title-button" type="button">Session title</button>
      <button class="chat-message-image-button" type="button">Image</button>
      <div class="sidebar-session-group-drag-handle"></div>
      <div class="session-tokens"><span class="session-tokens__value">12k</span></div>
      <span class="agent-tools-runtime-chip--more">+3</span>
      <div class="chat-text"><a class="markdown-file-link">src/index.ts</a></div>
      <div id="shadow-policy-host"><template shadowrootmode="open">
        <style>${dockPanelStyles.cssText}</style>
        <button id="shadow-new-tab-button" class="rail-header__action" type="button" data-new-tab-action>New tab</button>
        <button id="shadow-disabled-new-tab-button" class="rail-header__action" type="button" data-new-tab-action disabled>Unavailable new tab</button>
      </template></div>
    </main>
  </body></html>`;
}

type WindowProbe = {
  readonly cursors: Record<string, string>;
  readonly displayMode: string;
};

async function probeWindow(page: Page): Promise<WindowProbe> {
  return await page.evaluate((cursorCases: readonly CursorCase[]) => {
    const modes = ["browser", "standalone", "minimal-ui", "window-controls-overlay", "fullscreen"];
    const cursors = cursorCases.map(({ selector, shadow }) => {
      const element = shadow
        ? document
            .querySelector<HTMLElement>("#shadow-policy-host")
            ?.shadowRoot?.querySelector(selector)
        : document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing cursor fixture element for ${selector}`);
      }
      return [selector, getComputedStyle(element).cursor] as const;
    });
    return {
      cursors: Object.fromEntries(cursors),
      displayMode: modes.find((mode) => matchMedia(`(display-mode: ${mode})`).matches) ?? "unknown",
    };
  }, CURSOR_CASES);
}

function expectedCursors(): Record<string, string> {
  return Object.fromEntries(
    CURSOR_CASES.map((cursorCase) => [cursorCase.selector, cursorCase.expected]),
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
  it("uses semantic cursors in a browser tab", async () => {
    const page = await tabBrowser.newPage();
    try {
      await page.goto(`file://${fixtureFile}`);
      const probe = await probeWindow(page);

      expect(probe.displayMode).toBe("browser");
      expect(probe.cursors).toEqual(expectedCursors());
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("uses the same semantic cursors in a native app host", async () => {
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
      expect(probe.cursors).toEqual(expectedCursors());
    } finally {
      await page.close().catch(() => {});
    }
  });

  it("uses the same semantic cursors in an installed window", async () => {
    const [page] = appContext.pages();
    expect(page, "Chromium --app window did not expose a page").toBeDefined();
    await page!.waitForLoadState("load");
    const probe = await probeWindow(page!);

    expect(probe.displayMode).toBe("standalone");
    expect(probe.cursors).toEqual(expectedCursors());
  });
});
