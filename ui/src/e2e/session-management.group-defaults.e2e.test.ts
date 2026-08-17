import { expect, it } from "vitest";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("starts a session from a group with its saved folder and worktree defaults", async () => {
    const workspace = "/home/peter/openclaw";
    const initialGroupCwd = "/home/peter";
    const groupCwd = "/home/peter/client-work";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "fs.listDir": {
          path: groupCwd,
          parent: "/home/peter",
          home: "/home/peter",
          entries: [],
        },
        "sessions.create": { key: "agent:main:client-work", runStarted: true },
        "sessions.list": sessionsListResponse([]),
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
      sessionGroups: ["Client work"],
      sessionGroupDefaults: { "Client work": { cwd: initialGroupCwd, worktree: false } },
      workspace,
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Client work"]');
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "Group options for Client work" }).click();
      await page.getByRole("menuitem", { name: "New session defaults…" }).click();
      await page.evaluate(async () => customElements.whenDefined("wa-popover"));
      const dialog = page.locator(
        `openclaw-modal-dialog[label='New session defaults for "Client work"']`,
      );
      await dialog.waitFor({ state: "visible" });
      const folderTrigger = dialog.locator("#session-group-defaults-folder-trigger");
      await expect.poll(() => folderTrigger.getAttribute("aria-label")).toContain("peter");
      await folderTrigger.click();
      const folderPicker = dialog.locator("wa-popover.session-group-defaults__folder-popover");
      await folderPicker.getByRole("button", { name: "Browse folders" }).click();
      expect((await gateway.waitForRequest("fs.listDir")).params).toEqual({
        path: initialGroupCwd,
      });
      await expect
        .poll(() => folderPicker.locator("input.new-session-page__browser-path").inputValue())
        .toBe(groupCwd);
      for (const viewport of [
        { height: 844, name: "phone", width: 390 },
        { height: 1024, name: "tablet", width: 768 },
        { height: 900, name: "desktop", width: 1440 },
        { height: 500, name: "landscape", width: 932 },
      ]) {
        await page.setViewportSize(viewport);
        await expect
          .poll(async () => {
            const bounds = await folderPicker.locator(".new-session-page__browser").boundingBox();
            return {
              horizontal: Boolean(
                bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width,
              ),
              vertical: Boolean(
                bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
              ),
            };
          })
          .toEqual({ horizontal: true, vertical: true });
        await captureUiProof(page, `group-defaults-folder-picker-${viewport.name}.png`);
      }
      await folderPicker.getByRole("button", { name: "Use this folder" }).click();
      await page.setViewportSize({ height: 900, width: 1280 });
      await expect.poll(() => folderTrigger.textContent()).toContain("client-work");
      await expect.poll(() => dialog.locator('input[name="cwd"]').count()).toBe(0);
      await dialog.locator('select[name="mode"]').selectOption("worktree");
      await dialog.getByRole("button", { name: "Save" }).click();
      expect((await gateway.waitForRequest("sessions.groups.update")).params).toMatchObject({
        name: "Client work",
        cwd: groupCwd,
        worktree: true,
      });

      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "New session in Client work" }).click();
      await page.locator(".new-session-page__message").waitFor();
      await expect.poll(() => new URL(page.url()).searchParams.get("group")).toBe("Client work");
      await expect
        .poll(() =>
          page
            .locator("#new-session-project-trigger .new-session-page__trigger-label")
            .textContent(),
        )
        .toContain("client-work");
      expect((await gateway.waitForRequest("worktrees.branches")).params).toMatchObject({
        repoRoot: groupCwd,
      });
      await expect
        .poll(() => page.locator("#new-session-detail-trigger").getAttribute("data-worktree"))
        .toBe("true");

      await page.locator(".new-session-page__message").fill("prepare the client release");
      await page.getByRole("button", { name: "Start session" }).click();
      expect((await gateway.waitForRequest("sessions.create")).params).toMatchObject({
        agentId: "main",
        category: "Client work",
        cwd: groupCwd,
        message: "prepare the client release",
        worktree: true,
      });
    } finally {
      await context.close();
    }
  });

  it("omits the group category for a legacy Gateway", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["sessions.create", "sessions.groups.list"],
      methodResponses: {
        "sessions.create": { key: "agent:main:legacy-group", runStarted: true },
        "sessions.list": sessionsListResponse([]),
      },
      sessionGroups: ["Client work"],
      workspace: "/home/peter/openclaw",
      workspaceGit: false,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
      await page.locator(".new-session-page__message").fill("start on an older Gateway");
      await page.getByRole("button", { name: "Start session" }).click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({
        agentId: "main",
        message: "start on an older Gateway",
      });
      expect(create.params).not.toHaveProperty("category");
    } finally {
      await context.close();
    }
  });

  it("revalidates an open group route when its defaults or identity change", async () => {
    const initialCwd = "/home/peter/client-work";
    const refreshedCwd = "/home/peter/refreshed-client-work";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
      sessionGroups: ["Client work"],
      sessionGroupDefaults: { "Client work": { cwd: initialCwd, worktree: true } },
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
      const project = page.locator("#new-session-project-trigger .new-session-page__trigger-label");
      await expect.poll(() => project.textContent()).toContain("client-work");
      await page.locator(".new-session-page__message").fill("keep this draft");

      await page.evaluate(async (cwd) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              sessions: {
                groupsUpdate: (
                  name: string,
                  defaults: { cwd: string | null; worktree: boolean },
                ) => Promise<unknown>;
              };
            };
          };
        };
        await app.runtime?.context.sessions.groupsUpdate("Client work", {
          cwd,
          worktree: false,
        });
      }, refreshedCwd);

      await expect.poll(() => project.textContent()).toContain("refreshed-client-work");
      await expect
        .poll(() => page.locator("#new-session-detail-trigger").getAttribute("data-worktree"))
        .toBe("false");
      await expect
        .poll(() => page.locator(".new-session-page__message").inputValue())
        .toBe("keep this draft");

      await page.evaluate(async () => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              sessions: {
                groupsRename: (from: string, to: string) => Promise<unknown>;
              };
            };
          };
        };
        await app.runtime?.context.sessions.groupsRename("Client work", "Customer work");
      });

      const unavailable = page.locator(".new-session-page__catalog-unavailable");
      await expect
        .poll(() => unavailable.textContent())
        .toContain("This session target is unavailable.");
      await expect
        .poll(() => page.getByRole("button", { name: "Start session" }).isDisabled())
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("fails an open group route closed while remote catalog invalidation is unresolved", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([]),
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
      sessionGroups: ["Client work"],
      sessionGroupDefaults: {
        "Client work": { cwd: "/home/peter/client-work", worktree: true },
      },
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?group=Client+work`);
      const start = page.getByRole("button", { name: "Start session" });
      await page.locator(".new-session-page__message").fill("wait for fresh defaults");
      await expect.poll(() => start.isEnabled()).toBe(true);

      // Pin each wait past earlier sessions.groups.list traffic (the route
      // load already fetched the catalog) so a slow runner can't return a
      // stale earlier request.
      const groupListsBeforeInvalidation = (await gateway.getRequests("sessions.groups.list"))
        .length;
      await gateway.deferNext("sessions.groups.list");
      await gateway.emitGatewayEvent("sessions.changed", { reason: "groups" });
      await gateway.waitForRequest("sessions.groups.list", { after: groupListsBeforeInvalidation });
      await expect.poll(() => start.isDisabled()).toBe(true);
      await expect
        .poll(() => page.locator(".new-session-page__catalog-unavailable button").isDisabled())
        .toBe(true);
      const groupListsBeforeReject = (await gateway.getRequests("sessions.groups.list")).length;
      await gateway.deferNext("sessions.groups.list");
      await gateway.rejectDeferred("sessions.groups.list", {
        code: "UNAVAILABLE",
        message: "catalog reload failed",
      });
      await gateway.waitForRequest("sessions.groups.list", { after: groupListsBeforeReject });
      await expect
        .poll(() => page.locator(".new-session-page__catalog-unavailable").textContent())
        .toContain("This session target is unavailable.");
      await expect.poll(() => start.isDisabled()).toBe(true);
      await expect
        .poll(() => page.locator(".new-session-page__catalog-unavailable button").isDisabled())
        .toBe(true);

      await gateway.resolveDeferred("sessions.groups.list", {
        groups: [{ name: "Client work", position: 0 }],
      });
      await expect.poll(() => start.isEnabled()).toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps rejected group defaults editable and allows retry", async () => {
    const groupCwd = "/home/peter/client-work";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.update"],
      methodResponses: { "sessions.list": sessionsListResponse([]) },
      sessionGroups: ["Client work"],
      sessionGroupDefaults: { "Client work": { cwd: groupCwd, worktree: true } },
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Client work"]');
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "Group options for Client work" }).click();
      await page.getByRole("menuitem", { name: "New session defaults…" }).click();
      const dialog = page.locator(
        `openclaw-modal-dialog[label='New session defaults for "Client work"']`,
      );
      await dialog.waitFor({ state: "visible" });
      await dialog.locator('select[name="mode"]').selectOption("local");
      await dialog.getByRole("button", { name: "Save" }).click();
      await gateway.waitForRequest("sessions.groups.update");
      await gateway.rejectDeferred("sessions.groups.update", {
        code: "INVALID_REQUEST",
        message: "rejected group defaults",
      });

      const alert = dialog.getByRole("alert");
      await alert.waitFor({ state: "visible" });
      await expect.poll(() => alert.textContent()).toContain("rejected group defaults");
      await expect.poll(() => dialog.locator('select[name="mode"]').inputValue()).toBe("local");

      await dialog.getByRole("button", { name: "Save" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.update")).length)
        .toBe(2);
      await dialog.waitFor({ state: "detached" });

      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "New session in Client work" }).click();
      await page.locator("#new-session-detail-trigger").waitFor();
      await expect
        .poll(() => page.locator("#new-session-detail-trigger").getAttribute("data-worktree"))
        .toBe("false");
    } finally {
      await context.close();
    }
  });

  it("offers retry when authoritative group defaults are unavailable", async () => {
    const groupCwd = "/home/peter/client-work";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.groups.defaults"],
      methodResponses: { "sessions.list": sessionsListResponse([]) },
      sessionGroups: ["Client work"],
      sessionGroupDefaults: { "Client work": { cwd: groupCwd, worktree: true } },
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const group = page.locator('[data-session-section="category:Client work"]');
      await group.waitFor({ state: "visible", timeout: 10_000 });
      await gateway.waitForRequest("sessions.groups.list");
      await gateway.waitForRequest("sessions.groups.defaults");
      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "Group options for Client work" }).click();
      const defaultsAction = page.locator('wa-dropdown-item[value="group-defaults"]');
      await defaultsAction.waitFor({ state: "attached" });
      await expect.poll(() => defaultsAction.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);
      expect(
        await page
          .locator(`openclaw-modal-dialog[label='New session defaults for "Client work"']`)
          .count(),
      ).toBe(0);

      await gateway.rejectDeferred("sessions.groups.defaults", {
        code: "INVALID_REQUEST",
        message: "defaults unavailable",
      });
      await expect.poll(() => defaultsAction.textContent()).toContain("Retry");
      await expect.poll(() => defaultsAction.isEnabled()).toBe(true);

      // Pin past the load-time sessions.groups.list so the retry wait can't
      // return it stale.
      const groupListsBeforeRetry = (await gateway.getRequests("sessions.groups.list")).length;
      await gateway.deferNext("sessions.groups.list");
      await defaultsAction.click();
      await gateway.waitForRequest("sessions.groups.list", { after: groupListsBeforeRetry });
      await gateway.resolveDeferred("sessions.groups.list", {
        groups: [{ name: "Client work", position: 0 }],
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.defaults")).length)
        .toBe(2);

      await group.locator(".sidebar-recent-sessions__head").hover();
      await group.getByRole("button", { name: "Group options for Client work" }).click();
      const readyDefaultsAction = page.locator('wa-dropdown-item[value="group-defaults"]');
      await expect.poll(() => readyDefaultsAction.textContent()).not.toContain("Retry");
      await expect.poll(() => readyDefaultsAction.isEnabled()).toBe(true);
      await readyDefaultsAction.click();

      const dialog = page.locator(
        `openclaw-modal-dialog[label='New session defaults for "Client work"']`,
      );
      await dialog.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          dialog.locator("#session-group-defaults-folder-trigger").getAttribute("aria-label"),
        )
        .toContain("client-work");
      await expect.poll(() => dialog.locator('select[name="mode"]').inputValue()).toBe("worktree");
      expect(await gateway.getRequests("sessions.groups.update")).toHaveLength(0);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await context.close();
    }
  });

  it("blocks a missing group until a fresh catalog retry resolves it", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": sessionsListResponse([]) },
      sessionGroups: [],
      workspace: "/home/peter/openclaw",
      workspaceGit: true,
    });

    try {
      await page.goto(`${suite.server.baseUrl}new?group=Deleted`);
      const unavailable = page.locator(".new-session-page__catalog-unavailable");
      await unavailable.waitFor();
      await expect
        .poll(() => unavailable.textContent())
        .toContain("This session target is unavailable.");
      await page.locator(".new-session-page__message").fill("do not create this session");
      const start = page.getByRole("button", { name: "Start session" });
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);

      const listRequestsBeforeRetry = (await gateway.getRequests("sessions.groups.list")).length;
      await page.getByRole("button", { name: "Retry" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.groups.list")).length)
        .toBeGreaterThan(listRequestsBeforeRetry);
      await expect.poll(() => start.isDisabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
