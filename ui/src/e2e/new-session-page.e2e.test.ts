// Control UI tests cover the full-page new-session draft and its folder browser
// against a mocked Gateway: sidebar entry, fs.listDir browsing, and the final
// sessions.create payload.
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

const WORKSPACE = "/home/peter/openclaw";
const PICKED = "/home/peter/openclaw/packages";
const SOURCE_REPO = "/tmp/source-repo";
const TARGET_REPO = "/tmp/target-repo";
const NODE_HOME = "/Users/peter";
const NODE_PICKED = "/Users/peter/Projects";
const NODE_UNC = "\\\\server\\share\\repo";

function installRepositorySwitchGateway(page: Page, sessionKey: string) {
  return installMockGateway(page, {
    workspaceGit: true,
    methodResponses: {
      "agents.list": {
        agents: [
          {
            id: "main",
            identity: { name: "Main" },
            name: "Main",
            workspace: SOURCE_REPO,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      },
      "fs.listDir": {
        cases: [
          {
            match: { path: SOURCE_REPO },
            response: {
              path: SOURCE_REPO,
              parent: "/tmp",
              home: "/home/peter",
              entries: [],
            },
          },
        ],
      },
      "worktrees.branches": {
        cases: [
          {
            match: { repoRoot: SOURCE_REPO },
            response: {
              branches: [{ kind: "local", name: "alpha" }],
              headBranch: "alpha",
              repoRoot: SOURCE_REPO,
            },
          },
          {
            match: { repoRoot: TARGET_REPO },
            response: {
              branches: [
                { kind: "local", name: "main" },
                { kind: "local", name: "feature-choice" },
              ],
              headBranch: "main",
              repoRoot: TARGET_REPO,
            },
          },
        ],
      },
      "sessions.create": { key: sessionKey },
    },
  });
}

async function deferTargetRepositorySelection(
  page: Page,
  gateway: MockGatewayControls,
): Promise<Locator> {
  await page.goto(`${server.baseUrl}new`);
  await gateway.waitForRequest("worktrees.branches");

  const whereSelect = page.locator(
    ".new-session-page__select:not(.new-session-page__select--folder)",
  );
  await whereSelect.locator("summary").click();
  await page.getByRole("menuitemradio", { name: "Worktree" }).click();
  const baseInput = page.getByLabel("Base branch");
  await expect.poll(() => baseInput.inputValue()).toBe("alpha");
  const requestsBeforeSwitch = (await gateway.getRequests("worktrees.branches")).length;

  await gateway.deferNext("worktrees.branches");
  const folderSelect = page.locator(".new-session-page__select--folder");
  await folderSelect.locator("summary").click();
  await page
    .locator(".new-session-page__browser-list")
    .getByRole("button", { name: "Gateway" })
    .click();
  await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect
    .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
    .toBe(requestsBeforeSwitch + 1);
  return baseInput;
}

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

      // Unified layout: the trigger row (menus above the composer) sits
      // inside the start-screen welcome, below the hero.
      const heroBox = await page.locator(".agent-chat__welcome h2").boundingBox();
      const triggersBox = await page.locator(".new-session-page__triggers").boundingBox();
      const composerBox = await page.locator(".new-session-page__composer").boundingBox();
      expect(heroBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect((heroBox?.y ?? 0) + (heroBox?.height ?? 0)).toBeLessThanOrEqual(
        (triggersBox?.y ?? 0) + 1,
      );
      expect((triggersBox?.y ?? 0) + (triggersBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );

      // The folder trigger labels the workspace and opens the browser menu.
      const folderSelect = page.locator(".new-session-page__select--folder");
      await expect
        .poll(() => folderSelect.locator(".new-session-page__trigger-label").textContent())
        .toBe("openclaw");

      // Browse from the workspace, descend one level, then adopt the folder.
      await folderSelect.locator("summary").click();
      await page
        .locator(".new-session-page__browser-list")
        .getByRole("button", { name: "Gateway" })
        .click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator("input.new-session-page__browser-path").inputValue())
        .toBe(PICKED);
      await page.getByRole("button", { name: "Use this folder" }).click();

      // The adopted folder closes the menu and updates the trigger label.
      await expect.poll(() => folderSelect.getAttribute("open")).toBeNull();
      await expect
        .poll(() => folderSelect.locator(".new-session-page__trigger-label").textContent())
        .toBe("packages");

      // Custom host folders force a managed worktree (badge on the where
      // trigger; the menu item is checked and locked).
      const whereTrigger = page.locator('.new-session-page__trigger[data-worktree="true"]');
      await whereTrigger.waitFor();
      await whereTrigger.click();
      const worktreeItem = page.getByRole("menuitemradio", { name: "Worktree" });
      await expect.poll(() => worktreeItem.getAttribute("aria-checked")).toBe("true");
      expect(await worktreeItem.isDisabled()).toBe(true);
      await page.keyboard.press("Escape");

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

  it("does not submit a previous repository's worktree base while branches load", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installRepositorySwitchGateway(page, "agent:main:repo-switch");

    try {
      const baseInput = await deferTargetRepositorySelection(page, gateway);

      expect(await baseInput.inputValue()).toBe("");
      expect(await baseInput.getAttribute("placeholder")).toBe("Loading…");

      await page.locator(".new-session-page__message").fill("use the selected repository");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: TARGET_REPO,
        worktree: true,
      });
      expect(create.params).not.toHaveProperty("worktreeBaseRef");
      await gateway.resolveDeferred("worktrees.branches");
    } finally {
      await context.close();
    }
  });

  it("preserves a manually entered worktree base when branch discovery resolves", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installRepositorySwitchGateway(page, "agent:main:manual-base");

    try {
      const baseInput = await deferTargetRepositorySelection(page, gateway);
      await page
        .locator(".new-session-page__select:not(.new-session-page__select--folder) summary")
        .click();
      await baseInput.fill("feature-choice");
      await gateway.resolveDeferred("worktrees.branches");
      await expect.poll(() => baseInput.getAttribute("placeholder")).not.toBe("Loading…");
      expect(await baseInput.inputValue()).toBe("feature-choice");

      await page.locator(".new-session-page__message").fill("use my selected base");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: TARGET_REPO,
        worktree: true,
        worktreeBaseRef: "feature-choice",
      });
    } finally {
      await context.close();
    }
  });

  it("keeps a rejected first message visible and retryable after reload", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:rejected-first-message";
    const message = "keep this rejected first message";
    const runError = "send blocked by session policy";
    const gateway = await installMockGateway(page, {
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
        "sessions.list": {
          count: 1,
          path: "",
          sessions: [
            {
              hasActiveRun: false,
              key: sessionKey,
              kind: "direct",
              status: "done",
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
        "sessions.create": {
          key: sessionKey,
          runStarted: false,
          runError: { code: "INVALID_REQUEST", message: runError },
        },
        "chat.history": {
          messages: [],
          sessionId: "rejected-first-message",
          sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
        },
        "chat.send": { runId: "retry-run", status: "started" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.locator(".new-session-page__message").fill(message);
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message });

      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
      await expect.poll(() => page.locator(".chat-queue__text").allInnerTexts()).toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts())
        .toContain(runError);

      await page.reload();
      await expect.poll(() => page.locator(".chat-queue__text").allInnerTexts()).toContain(message);
      await expect
        .poll(() => page.locator(".chat-queue__error").allInnerTexts())
        .toContain(runError);

      await page.getByRole("button", { name: "Retry queued message" }).click();
      const retry = await gateway.waitForRequest("chat.send");
      expect(retry.params).toMatchObject({ sessionKey, message });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
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
      const folderSelect = page.locator(".new-session-page__select--folder");
      const whereSelect = page.locator(
        ".new-session-page__select:not(.new-session-page__select--folder)",
      );
      const whereTrigger = whereSelect.locator("summary");
      const whereLabel = whereSelect.locator(".new-session-page__trigger-label");

      // Pick the node from the where menu.
      await whereTrigger.click();
      await page.getByRole("menuitemradio", { name: "MacBook" }).click();
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");
      // Node sessions cannot use managed worktrees, so the menu drops the item.
      await whereTrigger.click();
      expect(await page.getByRole("menuitemradio", { name: "Worktree" }).count()).toBe(0);
      await page.keyboard.press("Escape");

      // Manual path entry in the browser head preserves UNC paths; these
      // cannot be rediscovered by starting at the node home directory.
      await folderSelect.locator("summary").click();
      const roots = page.locator(".new-session-page__browser-list");
      await roots.getByRole("button", { name: "MacBook" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill(NODE_UNC);
      await pathInput.press("Enter");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_UNC);
      // Close without applying; the draft keeps the node home default.
      await page.keyboard.press("Escape");

      // Back on the Gateway, the browser super-root lists every node.
      await whereTrigger.click();
      await page.getByRole("menuitemradio", { name: "Gateway · local" }).click();
      await expect.poll(() => whereLabel.textContent()).toBe("Gateway · local");
      await folderSelect.locator("summary").click();
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

      // Using a node folder retargets the draft to that node.
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");
      await expect
        .poll(() => folderSelect.locator(".new-session-page__trigger-label").textContent())
        .toBe("Projects");

      // Clearing the path applies the node's default directory (empty folder),
      // the state the replaced clearable folder textbox could express.
      await folderSelect.locator("summary").click();
      await roots.getByRole("button", { name: "MacBook" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_PICKED);
      await pathInput.fill("");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(() => folderSelect.locator(".new-session-page__trigger-label").textContent())
        .toBe("Agent workspace");
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");

      // Browse back to the custom folder for the final create assertion.
      await folderSelect.locator("summary").click();
      await roots.getByRole("button", { name: "MacBook" }).click();
      await roots.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(() => folderSelect.locator(".new-session-page__trigger-label").textContent())
        .toBe("Projects");

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
