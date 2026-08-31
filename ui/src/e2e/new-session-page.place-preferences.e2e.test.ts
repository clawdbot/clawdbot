import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { expect, it } from "vitest";
import {
  WORKSPACE,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const GIT_BRANCHES = {
  branches: [{ kind: "local", name: "main" }],
  defaultBranch: "main",
  repositoryStatus: "git",
};
const REGISTERED_PROJECT = {
  id: "registered",
  displayName: "Registered",
  repoRoot: "/srv/registered",
  source: "registered",
};

suite.define(() => {
  it("ignores a restored cloud preference for a write-scoped caller", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const appUrl = new URL(suite.server.baseUrl);
    const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
    const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
    await page.addInitScript(
      ({ key, workspace }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            agents: {
              main: { workspace, folder: workspace, where: { kind: "cloud", id: "aws" } },
            },
          }),
        );
      },
      { key: storageKey, workspace: WORKSPACE },
    );
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      operatorScopes: ["operator.read", "operator.write"],
      methodResponses: {
        "environments.list": {
          environments: [
            {
              id: "node:writer-runner",
              type: "node",
              label: "Writer runner",
              status: "available",
              sessionHost: true,
              workerSlots: { total: 1, available: 1 },
            },
          ],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      const where = page.locator("#new-session-where-trigger");
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBeNull();
      await where.click();
      const picker = page.locator("wa-popover.new-session-page__where-popover");
      await picker.locator('[data-value="device:writer-runner"]').waitFor();
      expect(await picker.locator('[data-value="cloud:aws"]').count()).toBe(0);
      await page.keyboard.press("Escape");
      await page.locator(".new-session-page__message").fill("start locally");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isEnabled())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("restores three-chip defaults from local storage without a durable identity", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const appUrl = new URL(suite.server.baseUrl);
    const gatewayUrl = `${appUrl.protocol === "https:" ? "wss:" : "ws:"}//${appUrl.host}`;
    const storageKey = `openclaw.new-session.preferences.v1:${gatewayOriginScope(gatewayUrl)}`;
    await page.addInitScript(
      ({ key, workspace }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            agents: {
              main: {
                workspace,
                folder: workspace,
                where: { kind: "local" },
                projectId: "registered",
                worktree: true,
                baseRef: "release/local",
                worktreeName: "browser-task",
              },
            },
          }),
        );
      },
      { key: storageKey, workspace: WORKSPACE },
    );
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
      methodResponses: {
        "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const project = page.locator("#new-session-project-trigger");
      const detail = page.locator("#new-session-detail-trigger");
      await expect.poll(() => project.getAttribute("data-project-id")).toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      await expect.poll(() => detail.getAttribute("data-worktree")).toBe("true");
      await detail.click();
      await expect.poll(() => page.getByLabel("Base branch").inputValue()).toBe("release/local");
      await expect.poll(() => page.getByLabel("Worktree name").inputValue()).toBe("browser-task");
      expect(await gateway.getRequests("users.prefs.get")).toHaveLength(0);
      expect(await gateway.getRequests("users.prefs.set")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("restores identity-scoped Where, What, and Detail defaults after discovery", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      presenceUsers: [{ self: true, id: "profile-alice", name: "Alice" }],
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "environments.list",
        "projects.list",
        "sessions.create",
        "users.prefs.get",
        "users.prefs.set",
        "worktrees.branches",
      ],
      methodResponses: {
        "environments.list": {
          environments: [{ id: "gateway", type: "local", status: "available" }],
          profiles: [{ id: "aws", providerId: "crabbox" }],
        },
        "projects.list": { projects: [REGISTERED_PROJECT], recents: [] },
        "users.prefs.get": {
          status: "ok",
          entries: {
            "new-session.migration.v1": true,
            "new-session.v1:main": {
              workspace: WORKSPACE,
              folder: WORKSPACE,
              where: { kind: "cloud", id: "aws" },
              projectId: "registered",
              worktree: true,
              baseRef: "release/next",
              worktreeName: "identity-task",
            },
          },
        },
        "users.prefs.set": { status: "ok" },
        "worktrees.branches": GIT_BRANCHES,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("users.prefs.get");
      const where = page.locator("#new-session-where-trigger");
      const project = page.locator("#new-session-project-trigger");
      const detail = page.locator("#new-session-detail-trigger");
      await expect.poll(() => where.getAttribute("data-cloud-profile")).toBe("aws");
      await pollLocatorText(where.locator(".new-session-page__trigger-label")).toBe("aws");
      await expect.poll(() => project.getAttribute("data-project-id")).toBe("registered");
      await pollLocatorText(project.locator(".new-session-page__trigger-label")).toBe("Registered");
      expect(await detail.count()).toBe(0);
      await project.click();
      const projectPopover = page.locator("wa-popover.new-session-page__project-popover");
      await projectPopover.getByText("Advanced", { exact: true }).click();
      await expect
        .poll(() => projectPopover.getByLabel("Base branch").inputValue())
        .toBe("release/next");
      await expect
        .poll(() => projectPopover.getByLabel("Checkout name").inputValue())
        .toBe("identity-task");
    } finally {
      await context.close();
    }
  });
});
