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
const REFRESHED_RESEARCH_WORKSPACE = "/home/peter/research-next";
const NODE_HOME = "/Users/peter";
const NODE_PICKED = "/Users/peter/Projects";
const NODE_UNC = "\\\\server\\share\\repo";
const EXEC_ONLY_PICKED = "C:\\Users\\peter\\repo";

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

  const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
  await page.locator("#new-session-where-trigger").click();
  await whereSelect.getByRole("button", { name: "Worktree" }).click();
  const baseInput = page.getByLabel("Base branch");
  await expect.poll(() => baseInput.inputValue()).toBe("alpha");
  const requestsBeforeSwitch = (await gateway.getRequests("worktrees.branches")).length;

  await gateway.deferNext("worktrees.branches");
  await page.locator("#new-session-folder-trigger").click();
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

async function replaceGatewayClient(page: Page) {
  await page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { connect: () => void } } };
    };
    if (!app.runtime) {
      throw new Error("OpenClaw application runtime is unavailable");
    }
    app.runtime.context.gateway.connect();
  });
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
        .poll(() =>
          page
            .locator("#new-session-folder-trigger .new-session-page__trigger-label")
            .textContent(),
        )
        .toBe("openclaw");

      // Browse from the workspace, descend one level, then adopt the folder.
      await page.locator("#new-session-folder-trigger").click();
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
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-folder-trigger");
      await expect
        .poll(() =>
          page
            .locator("#new-session-folder-trigger .new-session-page__trigger-label")
            .textContent(),
        )
        .toBe("packages");

      // Custom host folders force a managed worktree (badge on the where
      // trigger; the menu item is checked and locked).
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator('.new-session-page__trigger[data-worktree="true"]');
      await whereTrigger.waitFor();
      await whereTrigger.click();
      const worktreeItem = page.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktreeItem.getAttribute("aria-pressed")).toBe("true");
      expect(await worktreeItem.isDisabled()).toBe(true);
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-where-trigger");

      // Pointer light-dismiss keeps focus on the newly chosen control after
      // the asynchronous hide animation completes.
      await whereTrigger.click();
      const afterPointerHide = whereSelect.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("wa-after-hide", () => resolve(), { once: true });
          }),
      );
      await page.locator("#new-session-folder-trigger").click();
      await afterPointerHide;
      expect(await folderSelect.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await expect.poll(() => folderSelect.getAttribute("open")).toBeNull();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-folder-trigger");

      const message = page.locator(".new-session-page__message");
      await message.fill("fix the flaky test");
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

  it("creates a catalog-targeted draft with its advertised model", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
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
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:main:claude-draft" },
      },
    });

    try {
      const model = "anthropic/claude-opus-4-8";
      await page.goto(
        `${server.baseUrl}new?agent=Research&catalog=claude&model=${encodeURIComponent("openai/gpt-5")}&label=Spoofed`,
      );

      const catalogRequest = await gateway.waitForRequest("sessions.catalog.list");
      expect(catalogRequest.params).toMatchObject({
        agentId: "research",
        catalogId: "claude",
      });
      const runtime = page.locator(".new-session-page__runtime");
      await expect.poll(() => runtime.textContent()).toContain("Claude Code");
      expect(await runtime.getAttribute("title")).toBe(model);
      expect(await page.locator('.new-session-page__trigger[title="Agent"]').count()).toBe(0);

      await page.locator(".new-session-page__message").fill("use Claude Code");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "use Claude Code",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
    } finally {
      await context.close();
    }
  });

  it("creates a session while a canonical session refresh is pending", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:refresh-overlap-e2e";
    const listResponse = {
      count: 0,
      path: "",
      sessions: [],
      ts: Date.now(),
    };
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
        "sessions.create": { key: sessionKey },
        "sessions.list": listResponse,
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor({ state: "visible", timeout: 10_000 });
      const listCalls = (await gateway.getRequests("sessions.list")).length;

      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "agent:main:other-client",
        kind: "direct",
        reason: "update",
        sessionKey: "agent:main:other-client",
        updatedAt: Date.now(),
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBe(listCalls + 1);

      await message.fill("create during refresh");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "create during refresh",
      });
      expect(new URL(page.url()).pathname).toBe("/new");

      await gateway.resolveDeferred("sessions.list", listResponse);
      await expect
        .poll(() => new URL(page.url()).search)
        .toContain(`session=${encodeURIComponent(sessionKey)}`);
    } finally {
      await context.close();
    }
  });

  it("resolves a pending catalog target after reconnect without clearing the draft", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
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
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:research:claude-reconnect" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new?agent=research`);
      await page.getByRole("heading", { name: "Research" }).waitFor();
      await gateway.setOnline(false);
      await page.locator("openclaw-connection-banner").waitFor({ timeout: 10_000 });

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=research&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      const message = page.locator(".new-session-page__message");
      await message.fill("keep this reconnect draft");
      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("claude");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(false);
      expect(await gateway.getRequests("sessions.catalog.list")).toHaveLength(0);

      await gateway.deferNext("sessions.catalog.list");
      await gateway.setOnline(true);
      await gateway.waitForRequest("sessions.catalog.list");
      await gateway.deferNext("sessions.catalog.list");
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "catalog warming up",
        retryable: true,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length, {
          timeout: 10_000,
        })
        .toBe(3);
      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("Claude Code");
      await expect.poll(() => message.inputValue()).toBe("keep this reconnect draft");
      await expect
        .poll(() => page.getByRole("heading").first().textContent())
        .toContain("Research");

      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep this reconnect draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("preserves a manually selected agent across a same-client reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
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
        "sessions.create": { key: "agent:research:manual-reconnect" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await gateway.waitForRequest("worktrees.branches");
      const agentSelect = page.locator("wa-select.new-session-page__agent-select");
      await agentSelect.click();
      await agentSelect.getByRole("option", { name: "Research" }).click();
      await page.getByRole("heading", { name: "Research" }).waitFor();

      const message = page.locator(".new-session-page__message");
      await message.fill("keep my selected agent");
      const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
      const branchRequestsBefore = (await gateway.getRequests("worktrees.branches")).length;

      await gateway.setOnline(false);
      await page.locator("openclaw-connection-banner").waitFor({ timeout: 10_000 });
      await gateway.setMethodResponse("agents.list", {
        agents: [
          {
            id: "main",
            identity: { name: "Main" },
            name: "Main",
            workspace: WORKSPACE,
            workspaceGit: true,
          },
          {
            id: "research",
            identity: { name: "Research" },
            name: "Research",
            workspace: REFRESHED_RESEARCH_WORKSPACE,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("agents.list")).length)
        .toBe(agentRequestsBefore + 1);
      await expect.poll(() => message.inputValue()).toBe("keep my selected agent");
      await expect
        .poll(() => page.getByRole("heading").first().textContent())
        .toContain("Research");
      await expect
        .poll(() =>
          page
            .locator("#new-session-folder-trigger .new-session-page__trigger-label")
            .textContent(),
        )
        .toBe("research-next");
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequestsBefore + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
      });

      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      await whereTrigger.click();
      const worktreeItem = whereSelect.getByRole("button", { name: "Worktree" });
      await worktreeItem.click();
      const baseInput = page.getByLabel("Base branch");
      await expect.poll(() => baseInput.inputValue()).toBe("main");
      await page.keyboard.press("Escape");

      await gateway.deferNext("worktrees.branches");
      const branchesBeforeSameWorkspaceReconnect = (await gateway.getRequests("worktrees.branches"))
        .length;
      await gateway.setOnline(false);
      await page.locator("openclaw-connection-banner").waitFor({ timeout: 10_000 });
      await gateway.setOnline(true);

      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchesBeforeSameWorkspaceReconnect + 1);
      expect((await gateway.getRequests("worktrees.branches")).at(-1)?.params).toEqual({
        repoRoot: REFRESHED_RESEARCH_WORKSPACE,
      });
      expect(await baseInput.inputValue()).toBe("");
      expect(await baseInput.getAttribute("placeholder")).toBe("Loading…");
      await gateway.resolveDeferred("worktrees.branches", {
        branches: [{ kind: "local", name: "beta" }],
        defaultBranch: "beta",
      });
      await expect.poll(() => baseInput.inputValue()).toBe("beta");

      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "research",
        message: "keep my selected agent",
        worktree: true,
        worktreeBaseRef: "beta",
      });
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("validates a retained device before enabling submit after reconnect", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
        "node.list": {
          nodes: [
            {
              nodeId: "old-device",
              displayName: "Old device",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
        },
        "sessions.create": { key: "agent:main:validated-device" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      await page.locator("#new-session-where-trigger").click();
      await whereSelect.getByRole("button", { name: "Old device" }).click();
      await page.locator(".new-session-page__message").fill("use a validated device");
      const start = page.locator("button.chat-send-btn");
      const nodeRequestsBefore = (await gateway.getRequests("node.list")).length;

      await gateway.setOnline(false);
      await page.locator("openclaw-connection-banner").waitFor({ timeout: 10_000 });
      await gateway.deferNext("node.list");
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBe(nodeRequestsBefore + 1);
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      await gateway.resolveDeferred("node.list", { nodes: [] });
      await expect.poll(() => start.isEnabled()).toBe(true);
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).not.toHaveProperty("execNode");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("rediscovers Gateway-owned draft state when the app replaces its client", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Original agent" },
              name: "Original agent",
              workspace: SOURCE_REPO,
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
              nodeId: "old-device",
              displayName: "Old device",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "alpha" }],
          defaultBranch: "alpha",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await page.getByRole("heading", { name: "Original agent" }).waitFor();
      await gateway.waitForRequest("node.list");
      await gateway.waitForRequest("worktrees.branches");

      const message = page.locator(".new-session-page__message");
      const folderSelect = page.locator(".new-session-page__select--folder");
      const folderTrigger = page.locator("#new-session-folder-trigger");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      await message.fill("preserve this replacement draft");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old device" }).click();

      // Keep an old-client browser request in flight. Replacement must close
      // its menu and prevent its eventual completion from reviving old state.
      await gateway.deferNext("fs.listDir");
      await folderTrigger.click();
      await page
        .locator(".new-session-page__browser-list")
        .getByRole("button", { name: "Old device" })
        .click();
      await gateway.waitForRequest("fs.listDir");

      await gateway.setMethodResponse("agents.list", {
        agents: [
          {
            id: "main",
            identity: { name: "Replacement agent" },
            name: "Replacement agent",
            workspace: TARGET_REPO,
            workspaceGit: true,
          },
        ],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      });
      await gateway.setMethodResponse("node.list", {
        nodes: [
          {
            nodeId: "new-device",
            displayName: "New device",
            connected: true,
            commands: ["system.run", "fs.listDir"],
          },
        ],
      });
      await gateway.setMethodResponse("worktrees.branches", {
        branches: [{ kind: "local", name: "beta" }],
        defaultBranch: "beta",
      });
      const socketsBefore = await gateway.getSocketCount();
      const nodesBefore = (await gateway.getRequests("node.list")).length;
      const branchesBefore = (await gateway.getRequests("worktrees.branches")).length;

      await replaceGatewayClient(page);

      await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBe(nodesBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchesBefore + 1);
      await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
      await expect
        .poll(() =>
          folderSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect
        .poll(() => folderTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("target-repo");

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toEqual({ repoRoot: TARGET_REPO });
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "New device" }).waitFor();
      expect(await whereSelect.getByRole("button", { name: "Old device" }).count()).toBe(0);
      await whereSelect.getByRole("button", { name: "Worktree" }).click();
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("beta");

      await gateway.resolveDeferred("fs.listDir", {
        path: "/stale-device-path",
        home: "/stale-device-path",
        entries: [],
      });
      await expect
        .poll(() =>
          folderSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
    } finally {
      await context.close();
    }
  });

  for (const reconnectKind of ["same-client reconnect", "client replacement"] as const) {
    it(`marks a pending creation outcome unknown after ${reconnectKind}`, async () => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      const sessionKey = `agent:main:unknown-${reconnectKind.replaceAll(" ", "-")}`;
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              {
                id: "main",
                identity: { name: "Original agent" },
                name: "Original agent",
                workspace: SOURCE_REPO,
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
          "sessions.create": { key: sessionKey },
        },
      });

      try {
        await page.goto(`${server.baseUrl}new`);
        await page.getByRole("heading", { name: "Original agent" }).waitFor();
        const message = page.locator(".new-session-page__message");
        const start = page.locator("button.chat-send-btn");
        await message.fill("retry this draft after reconnect");
        await gateway.deferNext("sessions.create");
        await start.click();
        await gateway.waitForRequest("sessions.create");
        await expect.poll(() => start.isDisabled()).toBe(true);

        if (reconnectKind === "client replacement") {
          await gateway.setMethodResponse("agents.list", {
            agents: [
              {
                id: "main",
                identity: { name: "Replacement agent" },
                name: "Replacement agent",
                workspace: TARGET_REPO,
                workspaceGit: true,
              },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          });
          const socketsBefore = await gateway.getSocketCount();
          await replaceGatewayClient(page);
          await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
          await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
        } else {
          const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
          await gateway.setOnline(false);
          await page.locator("openclaw-connection-banner").waitFor({ timeout: 10_000 });
          await gateway.setOnline(true);
          await expect
            .poll(async () => (await gateway.getRequests("agents.list")).length)
            .toBe(agentRequestsBefore + 1);
        }
        await expect.poll(() => message.inputValue()).toBe("retry this draft after reconnect");
        await expect.poll(() => message.isEnabled()).toBe(true);
        await expect.poll(() => start.isDisabled()).toBe(true);
        await page
          .getByText(
            "The Gateway changed while this session was starting. Check recent sessions before starting this task again.",
          )
          .waitFor();
        expect(new URL(page.url()).searchParams.get("session")).toBeNull();
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      } finally {
        await context.close();
      }
    });
  }

  it("resets agent-derived workspace state when retargeted to a catalog", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
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
            {
              id: "research",
              identity: { name: "Research" },
              name: "Research",
              workspace: "/home/peter/research",
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
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: {
                continueSession: true,
                archive: false,
                createSession: { model: "anthropic/claude-opus-4-8" },
              },
              hosts: [],
            },
          ],
        },
        "sessions.create": { key: "agent:main:claude-retarget" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new?agent=research`);
      const folderLabel = page.locator(
        "#new-session-folder-trigger .new-session-page__trigger-label",
      );
      await expect.poll(() => folderLabel.textContent()).toBe("research");

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=main&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      await expect
        .poll(() => page.locator(".new-session-page__runtime").textContent())
        .toContain("Claude Code");
      await expect.poll(() => folderLabel.textContent()).toBe("openclaw");
      await page.locator(".new-session-page__message").fill("retarget this draft");
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "retarget this draft",
        catalogId: "claude",
      });
      expect(create.params).not.toHaveProperty("model");
      expect(create.params).not.toHaveProperty("cwd");
    } finally {
      await context.close();
    }
  });

  it("locks the submitted draft until creation settles and restores it after failure", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:locked-new-session-draft";
    const submittedMessage = "keep this submitted draft atomic";
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
        "sessions.list": {
          count: 0,
          path: "",
          sessions: [],
          ts: Date.now(),
        },
        "sessions.create": { key: sessionKey },
      },
    });

    try {
      await page.goto(`${server.baseUrl}new`);
      await gateway.deferNext("sessions.create");

      const draft = page.locator(".new-session-page__scroll");
      const message = page.locator(".new-session-page__message");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereSummary = page.locator("#new-session-where-trigger");
      const targetSummaries = page.locator(
        "#new-session-folder-trigger, #new-session-where-trigger",
      );

      await message.fill(submittedMessage);
      await whereSummary.click();
      expect(await whereSelect.getAttribute("open")).not.toBeNull();
      await page.getByRole("button", { name: "Start session" }).click();

      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ message: submittedMessage });
      await expect.poll(() => message.isDisabled()).toBe(true);
      expect(await draft.getAttribute("inert")).not.toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("true");
      expect(await whereSelect.getAttribute("open")).toBeNull();
      expect(
        await targetSummaries.evaluateAll((summaries) =>
          summaries.map((summary) => (summary as HTMLButtonElement).disabled),
        ),
      ).toEqual([true, true]);

      await expect(
        message.fill("silently discarded late edit", { timeout: 250 }),
      ).rejects.toThrow();
      await whereSummary.click({ force: true });
      await page.locator(".agent-chat__suggestion").first().click({ force: true });
      expect(await whereSelect.getAttribute("open")).toBeNull();
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);

      await gateway.rejectDeferred("sessions.create", {
        code: "UNAVAILABLE",
        message: "session creation unavailable",
      });
      await expect.poll(() => message.isDisabled()).toBe(false);
      expect(await draft.getAttribute("inert")).toBeNull();
      expect(await draft.getAttribute("aria-busy")).toBe("false");
      expect(await message.inputValue()).toBe(submittedMessage);
      expect(
        await targetSummaries.evaluateAll((summaries) =>
          summaries.map((summary) => (summary as HTMLButtonElement).disabled),
        ),
      ).toEqual([false, false]);

      await page.getByRole("button", { name: "Start session" }).click();
      await expect.poll(async () => (await gateway.getRequests("sessions.create")).length).toBe(2);
      const retry = (await gateway.getRequests("sessions.create")).at(-1);
      expect(retry?.params).toMatchObject({ message: submittedMessage });
      await page.waitForURL((url) => url.searchParams.get("session") === sessionKey, {
        timeout: 30_000,
      });
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
      await page.locator("#new-session-where-trigger").click();
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

  it("browses capable nodes and accepts manual paths for exec-only nodes", async () => {
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
      const folderTrigger = page.locator("#new-session-folder-trigger");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const whereLabel = whereTrigger.locator(".new-session-page__trigger-label");

      // Pick the node from the where menu.
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "MacBook" }).click();
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");
      // Node sessions cannot use managed worktrees, so the menu drops the item.
      await whereTrigger.click();
      expect(await whereSelect.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await page.keyboard.press("Escape");

      // Manual path entry in the browser head preserves UNC paths; these
      // cannot be rediscovered by starting at the node home directory.
      await folderTrigger.click();
      const roots = page.locator(".new-session-page__browser-list");
      await roots.getByRole("button", { name: "MacBook" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill(NODE_UNC);
      await pathInput.press("Enter");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_UNC);
      // Close without applying; the draft keeps the node home default.
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          folderSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);

      // Back on the Gateway, the browser super-root lists every node.
      await whereSelect.evaluate((element) => {
        (element as HTMLElement & { open: boolean }).open = true;
      });
      await expect
        .poll(() =>
          whereSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await whereSelect.getByRole("button", { name: "Gateway · local" }).click();
      await expect.poll(() => whereLabel.textContent()).toBe("Gateway · local");
      await folderTrigger.click();
      await expect
        .poll(() =>
          roots
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.textContent?.trim().replace(/\s+/g, " ")),
            ),
        )
        .toEqual(["Gateway · local", "MacBook", "Offline node", "Old node"]);
      const macbookRoot = roots.getByRole("button", { name: "MacBook" });
      const offlineRoot = roots.getByRole("button", { name: "Offline node" });
      const oldRoot = roots.getByRole("button", { name: "Old node" });
      expect(await macbookRoot.isEnabled()).toBe(true);
      expect(await macbookRoot.getAttribute("title")).toBeNull();
      // Offline rows stay disabled; exec-only rows accept a manual path.
      expect(await offlineRoot.isDisabled()).toBe(true);
      expect(await offlineRoot.getAttribute("title")).toBe("Device is offline");
      expect(await oldRoot.isEnabled()).toBe(true);
      expect(await oldRoot.getAttribute("title")).toBe(
        "This device doesn't support folder browsing",
      );

      await roots.getByRole("button", { name: "MacBook" }).click();
      await roots.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();

      // Using a node folder retargets the draft to that node.
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");
      await expect
        .poll(() => folderTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("Projects");

      // Clearing the path applies the node's default directory (empty folder),
      // the state the replaced clearable folder textbox could express.
      await folderTrigger.click();
      await roots.getByRole("button", { name: "MacBook" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_PICKED);
      await pathInput.fill("");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(() => folderTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("Agent workspace");
      await expect.poll(() => whereLabel.textContent()).toBe("MacBook");

      // Browse back to the custom folder, then retarget to the exec-only node
      // with a manual absolute path for the final create assertion.
      await folderTrigger.click();
      await roots.getByRole("button", { name: "MacBook" }).click();
      await roots.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(() => folderTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("Projects");

      await folderTrigger.click();
      await roots.getByRole("button", { name: "Old node" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe("");
      await pathInput.fill(EXEC_ONLY_PICKED);
      await pathInput.press("Enter");
      expect(
        (await gateway.getRequests("fs.listDir")).filter(
          (request) => (request.params as { nodeId?: string } | undefined)?.nodeId === "old-node",
        ),
      ).toHaveLength(0);
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => whereLabel.textContent()).toBe("Old node");
      await expect
        .poll(() => folderTrigger.locator(".new-session-page__trigger-label").textContent())
        .toBe("repo");

      await page.locator(".new-session-page__message").fill("inspect the remote checkout");
      await page.getByRole("button", { name: "Start session" }).click();
      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "inspect the remote checkout",
        execNode: "old-node",
        cwd: EXEC_ONLY_PICKED,
      });
      expect(createRequest.params).not.toHaveProperty("worktree");
    } finally {
      await context.close();
    }
  });
});
