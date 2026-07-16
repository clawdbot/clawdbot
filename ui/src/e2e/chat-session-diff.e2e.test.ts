// Control UI tests cover the session diff panel (sessions.diff RPC).
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function newBrowserContext(): Promise<BrowserContext> {
  const context = await browser.newContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
  openContexts.add(context);
  return context;
}

async function closeContexts(): Promise<void> {
  await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
  openContexts.clear();
}

const APP_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,3 +10,4 @@",
  " context line",
  "-removed line",
  "+replacement line",
  "+extra line",
  "",
].join("\n");

const NOTES_PATCH = [
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+scratch",
  "",
].join("\n");

describeControlUiE2e("session diff panel", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterAll(async () => {
    await closeContexts();
    await browser?.close();
    await server?.close();
  });

  afterEach(closeContexts);

  it("opens the diff sidebar with per-file patches and gap markers", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.diff": {
          sessionKey: "main",
          root: "/tmp/checkout",
          branch: "feature/panel",
          baseRef: "main",
          files: [
            {
              path: "src/app.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
              patch: APP_PATCH,
            },
            {
              path: "notes.md",
              status: "added",
              additions: 2,
              deletions: 0,
              untracked: true,
              patch: NOTES_PATCH,
            },
            {
              path: "logo.png",
              status: "modified",
              additions: 0,
              deletions: 0,
              binary: true,
            },
          ],
          additions: 4,
          deletions: 1,
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    await page.locator(".chat-session-diff-toggle").first().click();

    const panel = page.locator(".session-diff");
    await expect.poll(() => panel.count()).toBe(1);
    await expect
      .poll(() => panel.locator(".session-diff__branch-label").textContent())
      .toBe("main → feature/panel");

    const files = panel.locator(".session-diff__file");
    await expect.poll(() => files.count()).toBe(3);

    const modified = files.first();
    await expect
      .poll(() => modified.locator(".session-diff__path").textContent())
      .toContain("src/app.ts");
    // Hunk starting at old line 10 renders a leading gap marker.
    await expect
      .poll(() => modified.locator(".chat-diff__row--skip").first().textContent())
      .toContain("9 unmodified lines");
    await expect
      .poll(() => modified.locator(".chat-diff__row--add").first().textContent())
      .toContain("replacement line");

    const untracked = files.nth(1);
    await expect
      .poll(() => untracked.locator(".session-diff__badge").textContent())
      .toContain("untracked");

    const binary = files.nth(2);
    await expect
      .poll(() => binary.locator(".session-diff__note").textContent())
      .toContain("Binary file");

    // Collapsing a file hides its diff body.
    await modified.locator(".session-diff__file-header").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await modified.locator(".session-diff__file-header").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);
  });

  it("shows the not-a-git-checkout notice", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.diff": {
          sessionKey: "main",
          files: [],
          additions: 0,
          deletions: 0,
          unavailableReason: "not_git",
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    await page.locator(".chat-session-diff-toggle").first().click();
    await expect
      .poll(() => page.locator(".session-diff .session-diff__note").textContent())
      .toContain("not a git checkout");
  });
});
