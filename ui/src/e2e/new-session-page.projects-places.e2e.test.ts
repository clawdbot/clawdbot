import { expect, it } from "vitest";
import {
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  captureProjectUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
  prepareProjectUiProof,
  replaceGatewayClient,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const gatewayEnvironment = {
  id: "gateway",
  type: "local",
  status: "available",
};
suite.define(() => {
  it("registers a Git checkout from Browse and selects the refreshed project", async () => {
    await prepareProjectUiProof();
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const repoRoot = "/recorded/openclaw";
    const registeredProject = {
      id: "recorded-openclaw",
      displayName: "openclaw",
      repoRoot,
      originUrl: "https://github.com/openclaw/openclaw.git",
      source: "registered",
    };
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "fs.listDir",
        "projects.list",
        "projects.register",
        "sessions.create",
        "worktrees.branches",
      ],
      methodResponses: {
        "projects.list": {
          sequence: [{ projects: [] }, { projects: [registeredProject] }],
        },
        "projects.register": registeredProject,
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: { path: WORKSPACE, home: "/home/peter", entries: [] },
            },
            {
              match: { path: repoRoot },
              response: { path: repoRoot, parent: "/recorded", home: "/home/peter", entries: [] },
            },
          ],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await pathInput.fill(repoRoot);
      await pathInput.press("Enter");
      const register = place.getByRole("button", { name: "Register as project" });
      await register.waitFor();
      await captureProjectUiProof(page, "project-register-action.png");
      await register.click();

      const request = await gateway.waitForRequest("projects.register");
      expect(request.params).toEqual({ path: repoRoot });
      await expect.poll(async () => (await gateway.getRequests("projects.list")).length).toBe(2);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("openclaw");
      expect(await trigger.getAttribute("data-project-id")).toBe("recorded-openclaw");
    } finally {
      await context.close();
    }
  });

  it("handles a legacy projects-only response for write-scoped operators", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      operatorScopes: ["operator.read", "operator.write"],
      featureMethods: ["chat.metadata", "chat.startup", "projects.list", "sessions.create"],
      methodResponses: { "projects.list": { projects: [] } },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("projects.list");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await page.locator("#new-session-project-trigger").click();
      await place
        .getByText("Admins can register projects from Browse folders", { exact: true })
        .waitFor();
      expect(await place.getByRole("button", { name: "Register as project" }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps the Local destination visible when the Gateway is the only place", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": {
          environments: [gatewayEnvironment],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByRole("button", { name: "Local" }).waitFor();
      expect(await place.getByText("Your devices", { exact: true }).count()).toBe(0);
      expect(await place.getByText("Cloud", { exact: true }).count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("uses advertised system info for Gateway place labels", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create", "system.info"],
      methodResponses: {
        "system.info": {
          machineName: "Peters-Mac-Studio",
          hostname: "peters-mac-studio.local",
          platform: "darwin",
        },
        "environments.list": {
          environments: [gatewayEnvironment],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("system.info");
      const trigger = page.locator("#new-session-where-trigger");
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByRole("button", { name: /Local/u }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator("#new-session-project-trigger").click();
      await page
        .locator("wa-popover.new-session-page__project-popover")
        .getByRole("button", { name: "Browse folders" })
        .click();
      await expect
        .poll(() =>
          page.locator("input.new-session-page__browser-path").getAttribute("placeholder"),
        )
        .toBe("Gateway · Peters-Mac-Studio");

      await replaceGatewayClient(page);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      await place.getByRole("button", { name: /Local/u }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("keeps and disambiguates recent locations with the same basename", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "environments.list": { environments: [], profiles: [] },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            { key: "agent:main:a", kind: "direct", updatedAt: 2, execCwd: "/a/openclaw" },
            { key: "agent:main:b", kind: "direct", updatedAt: 1, execCwd: "/b/openclaw" },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:recent-collision" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      const first = page.locator('[data-value="recent:/a/openclaw"]');
      const second = page.locator('[data-value="recent:/b/openclaw"]');
      await first.waitFor();
      await second.waitFor();
      await pollLocatorText(first.locator(".session-menu__sub")).toBe("a");
      await pollLocatorText(second.locator(".session-menu__sub")).toBe("b");
      const recentValues = await page
        .locator('[data-value^="recent:"]')
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-value")));
      expect(recentValues).toEqual(["recent:/a/openclaw", "recent:/b/openclaw"]);
      await second.click();
      await page.locator(".new-session-page__message").fill("continue in work checkout");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: "/b/openclaw",
        message: "continue in work checkout",
      });
    } finally {
      await context.close();
    }
  });

  it("runs directly in a custom non-Git Gateway folder", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
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
        "environments.list": {
          environments: [gatewayEnvironment],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "fs.listDir": { path: WORKSPACE, home: "/home/peter", entries: [] },
        "worktrees.branches": {
          cases: [
            {
              match: { repoRoot: WORKSPACE },
              response: {
                branches: [{ kind: "local", name: "main" }],
                defaultBranch: "main",
                repositoryStatus: "git",
              },
            },
            {
              match: { repoRoot: "/home" },
              response: { branches: [], repositoryStatus: "not_git" },
            },
          ],
        },
        "sessions.create": { key: "agent:main:plain-folder" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-project-trigger");
      const place = page.locator("wa-popover.new-session-page__project-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").fill("/home");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("worktrees.branches")).at(-1)?.params)
        .toEqual({ repoRoot: "/home", includeRepositoryStatus: true });
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("home");

      expect(await page.locator("#new-session-detail-trigger").count()).toBe(0);
      await page.locator("#new-session-where-trigger").click();
      const where = page.locator("wa-popover.new-session-page__where-popover");
      await where.getByText("Cloud", { exact: true }).waitFor();
      const cloud = where.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      expect(await cloud.getAttribute("title")).toBe("Cloud needs a Git checkout");
      await page.keyboard.press("Escape");

      await page.locator(".new-session-page__message").fill("clone and inspect this project");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        cwd: "/home",
        message: "clone and inspect this project",
      });
      expect(create.params).not.toHaveProperty("worktree");
      expect(create.params).not.toHaveProperty("worktreeBaseRef");
    } finally {
      await context.close();
    }
  });
});
