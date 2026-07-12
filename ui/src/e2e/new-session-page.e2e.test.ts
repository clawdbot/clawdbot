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
const NODE_HOME = "/Users/peter";
const NODE_PICKED = "/Users/peter/Projects";
const NODE_UNC = "\\\\server\\share\\repo";

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
      // The draft page shows the start-screen welcome hero for the agent.
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await page.locator(".new-session-page__message").waitFor();

      // Unified layout: the draft block (target row above the composer) sits
      // inside the start-screen welcome, below the hero.
      const heroBox = await page.locator(".agent-chat__welcome h2").boundingBox();
      const targetsBox = await page.locator(".new-session-page__targets").boundingBox();
      const composerBox = await page.locator(".new-session-page__composer").boundingBox();
      expect(heroBox).not.toBeNull();
      expect(targetsBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect((heroBox?.y ?? 0) + (heroBox?.height ?? 0)).toBeLessThanOrEqual(
        (targetsBox?.y ?? 0) + 1,
      );
      expect((targetsBox?.y ?? 0) + (targetsBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );

      const folderInput = page.getByRole("textbox", { name: "Folder", exact: true });
      await expect.poll(() => folderInput.inputValue()).toBe(WORKSPACE);

      // Browse from the workspace, descend one level, then adopt the folder.
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page
        .locator(".new-session-page__browser-list")
        .getByRole("button", { name: "Gateway" })
        .click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator(".new-session-page__browser-path").textContent())
        .toBe(`Gateway · local · ${PICKED}`);
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

  it("shows Gateway and every node at the browser super-root and browses a capable node", async () => {
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
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
            {
              nodeId: "old-node",
              displayName: "Old node",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "offline-node",
              displayName: "Offline node",
              connected: false,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "fs.listDir": {
          cases: [
            {
              match: { nodeId: "macbook", path: NODE_UNC },
              response: {
                path: NODE_UNC,
                parent: "\\\\server\\share",
                home: "C:\\Users\\peter",
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook", path: NODE_PICKED },
              response: {
                path: NODE_PICKED,
                parent: NODE_HOME,
                home: NODE_HOME,
                entries: [],
              },
            },
            {
              match: { nodeId: "macbook" },
              response: {
                path: NODE_HOME,
                home: NODE_HOME,
                entries: [{ name: "Projects", path: NODE_PICKED }],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:node-draft-e2e" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor();
      const where = page.getByRole("combobox", { name: "Where" });
      const folder = page.getByRole("textbox", { name: "Folder", exact: true });
      await where.selectOption("macbook");
      await expect.poll(() => folder.inputValue()).toBe("");

      // Reopening a Windows node browser preserves UNC paths; these cannot be
      // rediscovered by starting at the node home directory.
      await folder.fill(NODE_UNC);
      await folder.press("Tab");
      await page.getByRole("button", { name: "Browse folders" }).click();
      await page
        .locator(".new-session-page__browser-list")
        .getByRole("button", { name: "MacBook" })
        .click();
      await expect
        .poll(() => page.locator(".new-session-page__browser-path").textContent())
        .toBe(`MacBook · ${NODE_UNC}`);
      await page.getByRole("button", { name: "Browse folders" }).click();
      await folder.fill("");
      await folder.press("Tab");

      await where.selectOption("");
      await expect.poll(() => folder.inputValue()).toBe(WORKSPACE);
      await page.getByRole("button", { name: "Browse folders" }).click();

      const roots = page.locator(".new-session-page__browser-list");
      await expect
        .poll(() =>
          roots
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.textContent?.trim().replace(/\s+/g, " ")),
            ),
        )
        .toEqual(["Gateway · local", "MacBook", "Offline node", "Old node"]);
      expect(await roots.getByRole("button", { name: "MacBook" }).isEnabled()).toBe(true);
      expect(await roots.getByRole("button", { name: "Offline node" }).isDisabled()).toBe(true);
      expect(await roots.getByRole("button", { name: "Old node" }).isDisabled()).toBe(true);

      await roots.getByRole("button", { name: "MacBook" }).click();
      await roots.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();

      await expect.poll(() => where.inputValue()).toBe("macbook");
      await expect.poll(() => folder.inputValue()).toBe(NODE_PICKED);
      const worktreeToggle = page.locator(".new-session-page__target--toggle input");
      expect(await worktreeToggle.isChecked()).toBe(false);
      expect(await worktreeToggle.isDisabled()).toBe(true);

      await page.locator(".new-session-page__message").fill("inspect the remote checkout");
      await page.getByRole("button", { name: "Start session" }).click();
      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "inspect the remote checkout",
        execNode: "macbook",
        cwd: NODE_PICKED,
      });
      expect(createRequest.params).not.toHaveProperty("worktree");
    } finally {
      await context.close();
    }
  });
});
