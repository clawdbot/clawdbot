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
import { activateChatHeaderPanelAction } from "./chat-side-panel.test-support.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let server: ControlUiE2eServer;
// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
const openContexts = new Set<BrowserContext>();

async function panelActionIds(page: import("playwright").Page): Promise<string[]> {
  return page.locator("openclaw-chat-header-session-menu").evaluate((element) =>
    (
      element as HTMLElement & {
        panelActions: Array<{ id: string }>;
      }
    ).panelActions.map((action) => action.id),
  );
}

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
  "@@ -30,3 +30,4 @@",
  " context line",
  "-removed line",
  "+replacement line",
  "+extra line",
  " trailing context",
  "",
].join("\n");

const APP_FILE_TEXT = [
  ...Array.from({ length: 29 }, (_, index) => `unchanged line ${index + 1}`),
  "context line",
  "replacement line",
  "extra line",
  "trailing context",
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
    const metadata = {
      aheadCount: 2,
      commits: [
        { sha: "def5678", subject: "Second feature change" },
        { sha: "abc1234", subject: "First feature change" },
      ],
      mergeBase: { sha: "0011223", subject: "Initial commit" },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff", "sessions.files.get"],
      methodResponses: {
        "sessions.files.get": {
          sessionKey: "main",
          root: "/tmp/checkout",
          file: {
            path: "src/app.ts",
            workspacePath: "src/app.ts",
            name: "app.ts",
            kind: "modified",
            missing: false,
            previewKind: "text",
            contentEncoding: "utf8",
            content: APP_FILE_TEXT,
          },
        },
        "sessions.diff": {
          cases: [
            {
              match: { scope: "uncommitted" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
                files: [
                  {
                    path: "notes.md",
                    status: "added",
                    additions: 2,
                    deletions: 0,
                    untracked: true,
                    patch: NOTES_PATCH,
                  },
                ],
                additions: 2,
                deletions: 0,
              },
            },
            {
              match: { scope: "commit", commit: "abc1234" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
                files: [
                  {
                    path: "src/app.ts",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    patch: APP_PATCH,
                  },
                ],
                additions: 2,
                deletions: 1,
              },
            },
            {
              match: { scope: "all" },
              response: {
                sessionKey: "main",
                root: "/tmp/checkout",
                branch: "feature/panel",
                baseRef: "main",
                ...metadata,
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
          ],
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);

    await activateChatHeaderPanelAction(page, "Show session changes");

    const panel = page.locator(".session-diff");
    await expect.poll(() => panel.count()).toBe(1);
    await expect
      .poll(() => panel.locator(".session-diff__branch-label").textContent())
      .toBe("main → feature/panel");
    await expect
      .poll(async () =>
        (await panel.locator(".session-diff__summary .chat-diffstat").textContent())?.replace(
          /\s/g,
          "",
        ),
      )
      .toBe("+3~1");

    const files = panel.locator(".session-diff__file");
    await expect.poll(() => files.count()).toBe(3);

    const modified = files.first();
    await expect
      .poll(() => modified.locator(".session-diff__filename").textContent())
      .toBe("app.ts");
    await expect.poll(() => modified.locator(".session-diff__directory").textContent()).toBe("src");
    // Hunk starting at old line 30 renders a leading expandable gap marker.
    await expect
      .poll(() => modified.locator(".chat-diff__row--skip").first().textContent())
      .toContain("29 unmodified lines");
    await expect
      .poll(() => modified.locator(".chat-diff__row--add").first().textContent())
      .toContain("replacement line");

    await modified.getByRole("button", { name: "Show next 20 unmodified lines" }).click();
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.files.get"))[0]?.params)
      .toMatchObject({ path: "src/app.ts" });
    await expect
      .poll(() => modified.locator(".chat-diff__row").first().textContent())
      .toContain("unchanged line 1");
    await expect
      .poll(() => modified.locator(".chat-diff__row--skip").first().textContent())
      .toContain("9 unmodified lines");
    await modified.getByRole("button", { name: "Show previous 9 unmodified lines" }).click();
    await expect.poll(() => modified.locator(".chat-diff__row--skip").count()).toBe(0);
    await expect.poll(async () => (await gateway.getRequests("sessions.files.get")).length).toBe(1);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);

    const untracked = files.nth(1);
    await expect
      .poll(() => untracked.locator(".session-diff__badge").textContent())
      .toContain("untracked");

    const binary = files.nth(2);
    await expect
      .poll(() => binary.locator(".session-diff__note").textContent())
      .toContain("Binary file");

    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitem", { name: "Switch to Split Diff" }).click();
    await expect.poll(() => modified.locator(".session-diff-split").count()).toBe(1);
    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitem", { name: "Switch to Unified Diff" }).click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);
    // View-only toggles reuse parsed patches after the expansion revalidations.
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);

    // Collapsing a file hides its diff body.
    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await panel.getByRole("button", { name: "Refresh changes" }).click();
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(4);
    // Refresh keeps the current collapse state instead of expanding every file.
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);

    // The section-title button opens the same scope menu as the footer.
    await panel.locator(".session-diff__section-title").click();
    await page
      .locator('openclaw-session-diff-menu wa-dropdown-item[value="scope:uncommitted"]')
      .click();
    await expect
      .poll(() => panel.locator(".session-diff__section-title span").textContent())
      .toBe("Uncommitted");
    await expect.poll(() => panel.locator(".session-diff__file").count()).toBe(1);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "uncommitted" });

    await panel.locator(".session-diff__footer").click();
    await page
      .locator('openclaw-session-diff-menu wa-dropdown-item[value="scope:commit:abc1234"]')
      .click();
    await expect
      .poll(() => panel.locator(".session-diff__section-title span").textContent())
      .toBe("abc1234 First feature change");
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "commit", commit: "abc1234" });
    await expect.poll(() => panel.locator(".session-diff__gap-controls").count()).toBe(0);
  });

  it("hides the diff toggle until the workspace becomes a git checkout", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.diff"],
      methodResponses: {
        "sessions.files.list": {
          sessionKey: "main",
          root: "/tmp/plain-workspace",
          gitCheckout: false,
          files: [],
          browser: { path: "", entries: [] },
        },
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
    await expect
      .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
      .toBe(1);

    await expect.poll(() => panelActionIds(page)).not.toContain("changes");
    await expect.poll(() => page.locator(".session-diff").count()).toBe(0);

    await gateway.setMethodResponse("sessions.files.list", {
      sessionKey: "main",
      root: "/tmp/plain-workspace",
      gitCheckout: true,
      files: [],
      browser: { path: "", entries: [] },
    });
    await gateway.emitChatFinal({ runId: "git-init-run", text: "Initialized repository." });
    await expect
      .poll(async () => (await gateway.getRequests("sessions.files.list")).length)
      .toBe(2);

    await expect.poll(() => panelActionIds(page)).toContain("changes");
  });

  it("keeps the panel fallback for gateways that omit checkout capability", async () => {
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

    await activateChatHeaderPanelAction(page, "Show session changes");
    await expect
      .poll(() => page.locator(".session-diff .session-diff__note").textContent())
      .toContain("not a git checkout");
  });
});
