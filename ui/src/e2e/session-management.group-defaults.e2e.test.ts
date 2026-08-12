import { expect, it } from "vitest";
import {
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("starts a session from a group with its saved folder and worktree defaults", async () => {
    const workspace = "/home/peter/openclaw";
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
      sessionGroupDefaults: { "Client work": { cwd: groupCwd, worktree: true } },
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
      const dialog = page.locator(
        `openclaw-modal-dialog[label='New session defaults for "Client work"']`,
      );
      await dialog.waitFor({ state: "visible" });
      await expect.poll(() => dialog.locator('input[name="cwd"]').inputValue()).toBe(groupCwd);
      await expect.poll(() => dialog.locator('select[name="mode"]').inputValue()).toBe("worktree");
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
});
