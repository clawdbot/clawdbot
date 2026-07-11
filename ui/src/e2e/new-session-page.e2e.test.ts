// Control UI tests cover the full-page new-session draft and its folder browser
// against a mocked Gateway: sidebar entry, fs.listDir browsing, and the final
// sessions.create payload.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const WORKSPACE = "/home/peter/openclaw";
const PICKED = "/home/peter/openclaw/packages";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI new-session page mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
        },
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                parent: "/home/peter",
                home: "/home/peter",
                entries: [
                  { name: "packages", path: PICKED },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: {
                path: PICKED,
                parent: WORKSPACE,
                home: "/home/peter",
                entries: [],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      // Deep-link to /new: the page loads agents via agents.list (the sidebar
      // "+" navigates to the same route with ?agent=<id>).
      const response = await page.goto(`${server.baseUrl}new`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "New session" }).waitFor();

      const folderInput = page.getByRole("textbox", { name: "Folder", exact: true });
      await expect.poll(() => folderInput.inputValue()).toBe(WORKSPACE);

      // Browse from the workspace, descend one level, then adopt the folder.
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator(".new-session-page__browser-path").textContent())
        .toBe(PICKED);
      await page.getByRole("button", { name: "Use this folder" }).click();

      await expect.poll(() => folderInput.inputValue()).toBe(PICKED);
      // Custom host folders force a managed worktree.
      const worktreeToggle = page.locator(".new-session-page__target--toggle input");
      await expect.poll(() => worktreeToggle.isChecked()).toBe(true);
      expect(await worktreeToggle.isDisabled()).toBe(true);

      await page.locator(".new-session-page__message").fill("fix the flaky test");
      await page.getByRole("button", { name: "Start session" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky test",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: PICKED,
      });

      await expect
        .poll(() => new URL(page.url()).search)
        .toContain(`session=${encodeURIComponent("agent:main:draft-e2e")}`);
    } finally {
      await context.close();
    }
  });
});
