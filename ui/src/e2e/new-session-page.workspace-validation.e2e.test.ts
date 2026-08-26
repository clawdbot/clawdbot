import type { BrowserContextOptions, Page } from "playwright";
import { expect, it } from "vitest";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  SOURCE_REPO,
  TARGET_REPO,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  replaceGatewayClient,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const BASE_CONTEXT: BrowserContextOptions = { locale: "en-US", serviceWorkers: "block" };
const DESKTOP_CONTEXT: BrowserContextOptions = {
  ...BASE_CONTEXT,
  viewport: { height: 900, width: 1280 },
};

function mainAgentList(name = "Main", workspace = WORKSPACE) {
  return {
    agents: [
      {
        id: "main",
        identity: { name },
        name,
        workspace,
        workspaceGit: true,
      },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  };
}

function branchList(name = "main") {
  return {
    branches: [{ kind: "local", name }],
    defaultBranch: name,
    repositoryStatus: "git",
  };
}

function deviceEnvironment(nodeId: string) {
  return {
    id: `node:${nodeId}`,
    type: "node",
    label: nodeId
      .split("-")
      .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    status: "available",
    sessionHost: true,
    workerSlots: { total: 1, available: 1 },
  };
}

async function withNewSessionPage(
  options: BrowserContextOptions,
  run: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await suite.browser.newContext(options);
  try {
    await run(await context.newPage());
  } finally {
    await context.close();
  }
}

type MockGateway = Awaited<ReturnType<typeof installMockGateway>>;

async function chooseCustomFolder(page: Page, gateway: MockGateway) {
  const trigger = page.locator("#new-session-project-trigger");
  const place = page.locator("wa-popover.new-session-page__project-popover");
  await trigger.click();
  await place.getByRole("button", { name: "Browse folders" }).click();
  await page.locator("input.new-session-page__browser-path").fill(TARGET_REPO);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect
    .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
    .toEqual({ repoRoot: TARGET_REPO, includeRepositoryStatus: true });
  return { place, trigger };
}

async function reconnectForBranchRediscovery(page: Page, gateway: MockGateway) {
  const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
  await gateway.setOnline(false);
  await waitForControlUiGatewayReconnecting(page);
  await gateway.setOnline(true);
  await waitForControlUiGatewayReady(page);
  await expect
    .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
    .toBe(branchRequests + 1);
}

suite.define(() => {
  it("preserves a selected workspace worktree when branch rediscovery is unavailable", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:worktree-unavailable" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("worktrees.branches");
      const trigger = page.locator("#new-session-detail-trigger");
      const place = page.locator("wa-popover.new-session-page__detail-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      const branchRequests = (await gateway.getRequests("worktrees.branches")).length;
      await gateway.deferNext("worktrees.branches");
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).length)
        .toBe(branchRequests + 1);
      await gateway.rejectDeferred("worktrees.branches", {
        code: "UNAVAILABLE",
        message: "branch lookup unavailable",
      });

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await trigger.click();
      const worktree = place.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktree.getAttribute("aria-pressed")).toBe("true");
      expect(await worktree.isEnabled()).toBe(true);
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("keep this task isolated");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "keep this task isolated",
        worktree: true,
      });
    });
  });

  it("clears a custom worktree when the folder becomes confirmed non-Git", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:custom-now-direct" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await chooseCustomFolder(page, gateway);
      const trigger = page.locator("#new-session-detail-trigger");
      const place = page.locator("wa-popover.new-session-page__detail-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "not_git",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => trigger.count()).toBe(0);
      const storedWorktree = await page.evaluate(() => {
        const key = Array.from({ length: localStorage.length }, (_, index) =>
          localStorage.key(index),
        ).find((candidate) => candidate?.startsWith("openclaw.new-session.preferences.v1:"));
        const value = key
          ? (JSON.parse(localStorage.getItem(key) ?? "null") as {
              agents?: Record<string, { worktree?: boolean }>;
            } | null)
          : null;
        return value?.agents?.main?.worktree;
      });
      expect(storedWorktree).toBe(false);
      await page.locator(".new-session-page__message").fill("continue directly");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ cwd: TARGET_REPO, message: "continue directly" });
      expect(create.params).not.toHaveProperty("worktree");
    });
  });

  it("allows clearing a custom worktree when Git rediscovery is unavailable", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
          "sessions.create": { key: "agent:main:custom-worktree-cleared" },
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await chooseCustomFolder(page, gateway);
      const trigger = page.locator("#new-session-detail-trigger");
      const place = page.locator("wa-popover.new-session-page__detail-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Worktree" }).click();
      await page.keyboard.press("Escape");
      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => trigger.getAttribute("data-worktree")).toBe("true");
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await trigger.click();
      const worktree = place.getByRole("button", { name: "Worktree" });
      expect(await worktree.isEnabled()).toBe(true);
      expect(await worktree.getAttribute("title")).toBe(
        "Couldn't verify Git for this folder. Choose it again to retry.",
      );
      await worktree.click();
      await expect.poll(() => trigger.count()).toBe(0);
      await expect.poll(() => start.isEnabled()).toBe(true);
      await page.keyboard.press("Escape");

      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        cwd: TARGET_REPO,
        message: "do not run directly",
      });
      expect(create.params).not.toHaveProperty("worktree");
    });
  });

  it("blocks a custom cloud worktree when Git rediscovery is unavailable", async () => {
    await withNewSessionPage(BASE_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        workspace: WORKSPACE,
        workspaceGit: true,
        methodResponses: {
          "environments.list": {
            environments: [],
            profiles: [{ id: "aws", providerId: "crabbox" }],
          },
          "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
          "worktrees.branches": branchList(),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const { place: project, trigger: projectTrigger } = await chooseCustomFolder(page, gateway);
      const whereTrigger = page.locator("#new-session-where-trigger");
      const where = page.locator("wa-popover.new-session-page__where-popover");
      const detailTrigger = page.locator("#new-session-detail-trigger");
      await whereTrigger.click();
      await where.getByRole("button", { name: "Cloud · aws" }).click();
      await expect.poll(() => whereTrigger.getAttribute("data-cloud-profile")).toBe("aws");
      expect(await detailTrigger.count()).toBe(0);

      await gateway.setMethodResponse("worktrees.branches", {
        branches: [],
        repositoryStatus: "unavailable",
      });
      await reconnectForBranchRediscovery(page, gateway);

      await expect.poll(() => whereTrigger.getAttribute("data-cloud-profile")).toBe("aws");
      expect(await detailTrigger.count()).toBe(0);
      await page.locator(".new-session-page__message").fill("do not run directly");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await whereTrigger.click();
      const cloud = where.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      expect(await cloud.getAttribute("title")).toBe(
        "Couldn't verify Git for this folder. Choose it again to retry.",
      );
      await page.keyboard.press("Escape");
      await projectTrigger.click();
      await project.getByText("Advanced", { exact: true }).click();
      await project.getByLabel("Base branch").waitFor();
      await project.getByLabel("Checkout name").waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    });
  });

  it("rediscovers Gateway-owned draft state when the app replaces its client", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": mainAgentList("Original agent", SOURCE_REPO),
          "environments.list": {
            environments: [deviceEnvironment("old-device")],
            profiles: [],
          },
          "worktrees.branches": branchList("alpha"),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("heading", { name: "Original agent" }).waitFor();
      await gateway.waitForRequest("environments.list");
      await gateway.waitForRequest("worktrees.branches");

      const message = page.locator(".new-session-page__message");
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      await message.fill("preserve this replacement draft");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old device" }).click();

      // Keep an old-client browser request in flight. Replacement must close
      // its menu and prevent its eventual completion from reviving old state.
      await gateway.deferNext("fs.listDir");
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");

      await gateway.setMethodResponse(
        "agents.list",
        mainAgentList("Replacement agent", TARGET_REPO),
      );
      await gateway.setMethodResponse("environments.list", {
        environments: [deviceEnvironment("new-device")],
        profiles: [],
      });
      await gateway.setMethodResponse("worktrees.branches", branchList("beta"));
      const socketsBefore = await gateway.getSocketCount();
      const environmentsBefore = (await gateway.getRequests("environments.list")).length;
      const branchesBefore = (await gateway.getRequests("worktrees.branches")).length;

      await replaceGatewayClient(page);

      await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBe(environmentsBefore + 1);
      await expect
        .poll(async () =>
          (await gateway.getRequests("worktrees.branches"))
            .slice(branchesBefore)
            .map((request) => request.params),
        )
        .toEqual([{ repoRoot: TARGET_REPO, includeRepositoryStatus: true }]);
      await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await pollLocatorText(projectTrigger.locator(".new-session-page__trigger-label")).toBe(
        "target-repo",
      );

      const branchRequests = await gateway.getRequests("worktrees.branches");
      expect(branchRequests.at(-1)?.params).toEqual({
        repoRoot: TARGET_REPO,
        includeRepositoryStatus: true,
      });
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "New device" }).waitFor();
      expect(await whereSelect.getByRole("button", { name: "Old device" }).count()).toBe(0);
      await page.keyboard.press("Escape");
      expect(await page.locator("#new-session-detail-trigger").count()).toBe(0);
      await projectTrigger.click();
      await projectSelect.getByText("Advanced", { exact: true }).click();
      await expect.poll(() => projectSelect.getByLabel("Base branch").inputValue()).toBe("beta");
      await page.keyboard.press("Escape");

      await gateway.resolveDeferred("fs.listDir", {
        path: "/stale-device-path",
        home: "/stale-device-path",
        entries: [],
      });
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(false);
      await expect.poll(() => message.inputValue()).toBe("preserve this replacement draft");
    });
  });

  for (const reconnectKind of ["same-client reconnect", "client replacement"] as const) {
    it(`automatically resumes an idempotent session creation after ${reconnectKind}`, async () => {
      await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
        const sessionKey = `agent:main:resumed-${reconnectKind.replaceAll(" ", "-")}`;
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": mainAgentList("Original agent", SOURCE_REPO),
            "worktrees.branches": branchList(),
            "sessions.create": { key: sessionKey },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        await page.getByRole("heading", { name: "Original agent" }).waitFor();
        const message = page.locator(".new-session-page__message");
        const projectTrigger = page.locator("#new-session-project-trigger");
        const start = page.locator("button.new-session-page__start-submit");
        await message.fill("retry this draft after reconnect");
        await gateway.deferNext("sessions.create");
        await start.click();
        const originalCreate = await gateway.waitForRequest("sessions.create");
        await expect.poll(() => start.isDisabled()).toBe(true);
        await gateway.deferNext("sessions.create");

        if (reconnectKind === "client replacement") {
          await gateway.setMethodResponse(
            "agents.list",
            mainAgentList("Replacement agent", TARGET_REPO),
          );
          const socketsBefore = await gateway.getSocketCount();
          await replaceGatewayClient(page);
          await expect.poll(() => gateway.getSocketCount()).toBe(socketsBefore + 1);
          await page.getByRole("heading", { name: "Replacement agent" }).waitFor();
        } else {
          const agentRequestsBefore = (await gateway.getRequests("agents.list")).length;
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          expect(await message.isDisabled()).toBe(true);
          expect(await projectTrigger.isDisabled()).toBe(true);
          expect(await start.getAttribute("aria-busy")).toBe("true");
          await gateway.setOnline(true);
          await waitForControlUiGatewayReady(page);
          await expect
            .poll(async () => (await gateway.getRequests("agents.list")).length)
            .toBe(agentRequestsBefore + 1);
        }
        await expect
          .poll(async () => (await gateway.getRequests("sessions.create")).length)
          .toBe(2);
        const resumedCreate = (await gateway.getRequests("sessions.create")).at(-1);
        expect(originalCreate.params).toMatchObject({
          idempotencyKey: expect.any(String),
          message: "retry this draft after reconnect",
        });
        expect(resumedCreate?.params).toEqual(originalCreate.params);
        expect(await message.inputValue()).toBe("retry this draft after reconnect");
        expect(await message.isDisabled()).toBe(true);
        expect(await projectTrigger.isDisabled()).toBe(true);
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await gateway.resolveDeferred("sessions.create", { key: sessionKey });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));
      });
    });
  }

  it("keeps an interrupted creation fail-closed after the Gateway process restarts", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": mainAgentList(),
          "worktrees.branches": branchList(),
        },
      });
      await page.goto(`${suite.server.baseUrl}new`);
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await page.locator(".new-session-page__message").fill("do not duplicate this task");
      await gateway.deferNext("sessions.create");
      await page.getByRole("button", { name: "Start session" }).click();
      await gateway.waitForRequest("sessions.create");

      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await gateway.setGatewayBootId("different-gateway-process");
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);

      await page
        .getByRole("alert")
        .filter({
          hasText:
            "The Gateway changed while this session was starting. Check recent sessions before starting this task again.",
        })
        .waitFor();
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(new URL(page.url()).pathname).toBe("/new");
    });
  });

  it("resets agent-derived workspace state when retargeted to a catalog", async () => {
    await withNewSessionPage(DESKTOP_CONTEXT, async (page) => {
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
          "worktrees.branches": branchList(),
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
      await page.goto(`${suite.server.baseUrl}new?agent=research`);
      const folderLabel = page.locator(
        "#new-session-project-trigger .new-session-page__trigger-label",
      );
      await pollLocatorText(folderLabel).toBe("research");

      await page.evaluate(() => {
        history.pushState(null, "", "new?agent=main&catalog=claude");
        dispatchEvent(new PopStateEvent("popstate"));
      });

      await pollLocatorText(page.locator(".new-session-page__runtime")).toContain("Claude Code");
      await pollLocatorText(folderLabel).toBe("openclaw");
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
    });
  });
});
