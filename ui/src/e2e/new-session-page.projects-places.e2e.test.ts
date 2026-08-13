import { expect, it } from "vitest";
import {
  EXEC_ONLY_PICKED,
  NODE_HOME,
  NODE_PICKED,
  NODE_UNC,
  SESSION_LIST_DEFAULTS,
  WORKSPACE,
  captureProjectUiProof,
  captureUiProof,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
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
const deviceEnvironment = (nodeId: string) => ({
  id: `node:${nodeId}`,
  type: "node",
  status: "available",
});

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
        "node.list": { nodes: [] },
        "environments.list": {
          environments: [gatewayEnvironment],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
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
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": {
          environments: [gatewayEnvironment, deviceEnvironment("macbook")],
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

      await gateway.setMethodResponse("node.list", { nodes: [] });
      const nodeRequests = (await gateway.getRequests("node.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("node.list")).length)
        .toBeGreaterThan(nodeRequests);
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Local");
      await trigger.click();
      await place.getByRole("button", { name: /Local/u }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("shows live devices when the initial environment catalog is unavailable", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "fallback-device",
              displayName: "Fallback device",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "environment catalog unavailable",
          },
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      await gateway.waitForRequest("environments.list");
      await page.locator("#new-session-where-trigger").click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByText("Your devices", { exact: true }).waitFor();
      await place.getByRole("button", { name: "Fallback device" }).waitFor();
      await captureUiProof(page, "04-catalog-unavailable-device-fallback.png");
    } finally {
      await context.close();
    }
  });

  it("keeps the last environment catalog across a same-Gateway client refresh failure", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "stable-device",
              displayName: "Stable device",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": {
          environments: [deviceEnvironment("stable-device")],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const trigger = page.locator("#new-session-where-trigger");
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Stable device" }).waitFor();
      await page.keyboard.press("Escape");

      await gateway.setMethodResponse("environments.list", {
        __mockError: {
          code: "UNAVAILABLE",
          message: "environment refresh unavailable",
        },
      });
      const environmentRequests = (await gateway.getRequests("environments.list")).length;
      await replaceGatewayClient(page);
      await expect
        .poll(async () => (await gateway.getRequests("environments.list")).length)
        .toBeGreaterThan(environmentRequests);

      await trigger.click();
      await place.getByRole("button", { name: "Stable device" }).waitFor();
    } finally {
      await context.close();
    }
  });

  it("disambiguates duplicate node names without changing the selected chip", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "11111111aaaaaaaa",
              displayName: "Mac Studio",
              platform: "darwin",
              modelIdentifier: "Mac14,12",
              remoteIp: "192.168.1.11",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "22222222bbbbbbbb",
              displayName: "Mac Studio",
              platform: "darwin",
              modelIdentifier: "Mac15,14",
              remoteIp: "192.168.1.12",
              connected: true,
              commands: ["system.run"],
            },
            {
              nodeId: "33333333cccccccc",
              displayName: "iPhone",
              platform: "iOS 26.4",
              deviceFamily: "iPhone",
              modelIdentifier: "iPhone17,2",
              remoteIp: "192.168.1.30",
              connected: true,
              commands: ["system.run"],
            },
          ],
        },
        "environments.list": {
          environments: [
            gatewayEnvironment,
            { id: "node:11111111aaaaaaaa", type: "node", status: "available" },
            deviceEnvironment("22222222bbbbbbbb"),
            deviceEnvironment("33333333cccccccc"),
          ],
          profiles: [],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-where-trigger");
      await trigger.click();
      const place = page.locator("wa-popover.new-session-page__where-popover");
      await place.getByRole("button", { name: /Local/u }).waitFor();
      await place.getByText("Your devices", { exact: true }).waitFor();
      const first = page.locator('[data-value="node:11111111aaaaaaaa"]');
      const second = page.locator('[data-value="node:22222222bbbbbbbb"]');
      const phone = page.locator('[data-value="node:33333333cccccccc"]');
      await pollLocatorText(first.locator(".session-menu__sub")).toBe("Mac14,12");
      await pollLocatorText(second.locator(".session-menu__sub")).toBe("Mac15,14");
      await pollLocatorText(phone.locator(".session-menu__text")).toBe("iPhone");
      expect(await first.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await second.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await phone.locator(".session-menu__icon svg").count()).toBe(1);
      expect(await first.getAttribute("title")).toBe("macOS · Mac14,12 · 192.168.1.11");
      expect(await second.getAttribute("title")).toContain("192.168.1.12");
      await captureUiProof(page, "03-legacy-device-picker.png");
      await second.click();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Mac Studio");
      expect(await trigger.textContent()).not.toContain("Mac15,14");
      expect(await trigger.textContent()).not.toContain("192.168.1.12");
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
        "node.list": { nodes: [] },
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
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      const first = page.locator('[data-value="recent::/a/openclaw"]');
      const second = page.locator('[data-value="recent::/b/openclaw"]');
      await first.waitFor();
      await second.waitFor();
      await pollLocatorText(first.locator(".session-menu__sub")).toBe("a");
      await pollLocatorText(second.locator(".session-menu__sub")).toBe("b");
      const recentValues = await page
        .locator('[data-value^="recent::"]')
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-value")));
      expect(recentValues).toEqual(["recent::/a/openclaw", "recent::/b/openclaw"]);
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

  it("applies a recent folder and node as one place", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "node.list": {
          nodes: [
            {
              nodeId: "macbook",
              displayName: "MacBook",
              connected: true,
              commands: ["system.run", "fs.listDir"],
            },
          ],
        },
        "environments.list": {
          environments: [gatewayEnvironment, deviceEnvironment("macbook")],
          profiles: [],
        },
        "sessions.list": {
          count: 2,
          defaults: SESSION_LIST_DEFAULTS,
          path: "",
          sessions: [
            {
              key: "agent:main:recent-node",
              kind: "direct",
              updatedAt: 2,
              execCwd: NODE_PICKED,
              execNode: "macbook",
            },
            {
              key: "agent:main:workspace",
              kind: "direct",
              updatedAt: 1,
              execCwd: WORKSPACE,
            },
          ],
          ts: Date.now(),
        },
        "sessions.create": { key: "agent:main:recent-place" },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("node.list");
      const trigger = page.locator("#new-session-project-trigger");
      await trigger.click();
      await page
        .locator("wa-popover.new-session-page__project-popover")
        .getByRole("button", { name: /Projects.*MacBook/u })
        .click();
      await pollLocatorText(trigger.locator(".new-session-page__trigger-label")).toBe("Projects");
      await pollLocatorText(
        page.locator("#new-session-where-trigger .new-session-page__trigger-label"),
      ).toBe("MacBook");

      await page.locator(".new-session-page__message").fill("continue on the recent node");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        cwd: NODE_PICKED,
        execNode: "macbook",
        message: "continue on the recent node",
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

      await page.locator("#new-session-detail-trigger").click();
      const detail = page.locator("wa-popover.new-session-page__detail-popover");
      expect(await detail.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await detail.getByText("Runs directly in the selected folder.", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      await page.locator("#new-session-where-trigger").click();
      const where = page.locator("wa-popover.new-session-page__where-popover");
      await where.getByText("Cloud", { exact: true }).waitFor();
      const cloud = where.getByRole("button", { name: "Cloud · aws" });
      expect(await cloud.isDisabled()).toBe(true);
      expect(await cloud.getAttribute("title")).toBe("Cloud workers require a managed worktree");
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

  it("browses capable nodes and accepts manual paths for exec-only nodes", async () => {
    const context = await suite.browser.newContext({
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
        "environments.list": {
          environments: [
            gatewayEnvironment,
            deviceEnvironment("macbook"),
            deviceEnvironment("old-node"),
            deviceEnvironment("offline-node"),
          ],
          profiles: [],
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
        "sessions.list": createdSessionListResult("agent:main:node-draft-e2e"),
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor();
      const whereSelect = page.locator("wa-popover.new-session-page__where-popover");
      const whereTrigger = page.locator("#new-session-where-trigger");
      const whereLabel = whereTrigger.locator(".new-session-page__trigger-label");
      const projectSelect = page.locator("wa-popover.new-session-page__project-popover");
      const projectTrigger = page.locator("#new-session-project-trigger");
      const projectLabel = projectTrigger.locator(".new-session-page__trigger-label");
      const detailSelect = page.locator("wa-popover.new-session-page__detail-popover");
      const detailTrigger = page.locator("#new-session-detail-trigger");
      const browserEntries = page.locator(".new-session-page__browser-list");

      await whereTrigger.click();
      await whereSelect.getByText("Your devices", { exact: true }).waitFor();
      await whereSelect.getByRole("button", { name: "MacBook" }).click();
      await pollLocatorText(whereLabel).toBe("MacBook");
      await detailTrigger.click();
      expect(await detailSelect.getByRole("button", { name: "Worktree" }).count()).toBe(0);
      await detailSelect.getByLabel("Working directory").waitFor();
      await page.keyboard.press("Escape");

      // Manual path entry in the browser head preserves UNC paths; these
      // cannot be rediscovered by starting at the node home directory.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      const pathInput = page.locator("input.new-session-page__browser-path");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill(NODE_UNC);
      await pathInput.press("Enter");
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_UNC);
      // Escape returns to the picker root without applying or closing it.
      await page.keyboard.press("Escape");
      await expect
        .poll(() =>
          projectSelect.evaluate((element) => (element as HTMLElement & { open: boolean }).open),
        )
        .toBe(true);
      await projectSelect.getByRole("button", { name: "Browse folders" }).waitFor();

      await page.keyboard.press("Escape");
      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Local" }).click();
      await pollLocatorText(whereLabel).toBe("Local");
      await whereTrigger.click();
      expect(await whereSelect.getByRole("button", { name: "Offline node" }).count()).toBe(0);
      await whereSelect.getByRole("button", { name: "MacBook" }).click();
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();

      // Using a node folder retargets the draft to that node.
      await pollLocatorText(whereLabel).toBe("MacBook");
      await pollLocatorText(projectLabel).toBe("Projects");

      // A node cwd belongs to the selected agent's draft and must not leak
      // across an agent change, even though the execution node stays selected.
      const agentPicker = page.locator(".new-session-page__select--agent openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "Research" })
        .click();
      await page.getByRole("heading", { name: "Research" }).waitFor();
      await pollLocatorText(whereLabel).toBe("MacBook");
      await pollLocatorText(projectLabel).toBe("research");

      // Clearing the path applies the node's default directory (empty folder),
      // the state the replaced clearable folder textbox could express.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await expect.poll(() => pathInput.inputValue()).toBe(NODE_HOME);
      await pathInput.fill("");
      await page.getByRole("button", { name: "Use this folder" }).click();
      await pollLocatorText(projectLabel).toBe("research");

      // Browse back to the custom folder, then retarget to the exec-only node
      // with a manual absolute path for the final create assertion.
      await projectTrigger.click();
      await projectSelect.getByRole("button", { name: "Browse folders" }).click();
      await browserEntries.getByRole("button", { name: "Projects" }).click();
      await page.getByRole("button", { name: "Use this folder" }).click();
      await pollLocatorText(projectLabel).toBe("Projects");

      await whereTrigger.click();
      await whereSelect.getByRole("button", { name: "Old node" }).click();
      await detailTrigger.click();
      const nodeCwd = detailSelect.getByLabel("Working directory");
      await expect.poll(() => nodeCwd.inputValue()).toBe("");
      await nodeCwd.fill(EXEC_ONLY_PICKED);
      await nodeCwd.press("Enter");
      expect(
        (await gateway.getRequests("fs.listDir")).filter(
          (request) => (request.params as { nodeId?: string } | undefined)?.nodeId === "old-node",
        ),
      ).toHaveLength(0);
      await page.keyboard.press("Escape");
      await pollLocatorText(whereLabel).toBe("Old node");
      await pollLocatorText(projectLabel).toBe("repo");

      await page.locator(".new-session-page__message").fill("inspect the remote checkout");
      await page.getByRole("button", { name: "Start session" }).click();
      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "research",
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
