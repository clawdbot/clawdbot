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
      const folderTrigger = dialog.getByRole("button", {
        name: "Working directory: client-work",
      });
      await folderTrigger.click();
      const folderPicker = dialog.locator("wa-popover.session-group-defaults__folder-popover");
      await folderPicker.getByRole("button", { name: "Browse folders" }).click();
      expect((await gateway.waitForRequest("fs.listDir")).params).toEqual({ path: groupCwd });
      await expect
        .poll(() => folderPicker.locator("input.new-session-page__browser-path").inputValue())
        .toBe(groupCwd);
      for (const viewport of [
        { height: 844, name: "phone", width: 390 },
        { height: 1024, name: "tablet", width: 768 },
        { height: 900, name: "desktop", width: 1440 },
      ]) {
        await page.setViewportSize(viewport);
        const pickerBounds = await folderPicker.locator(".new-session-page__browser").boundingBox();
        expect(pickerBounds).not.toBeNull();
        expect(pickerBounds?.x).toBeGreaterThanOrEqual(0);
        expect((pickerBounds?.x ?? 0) + (pickerBounds?.width ?? 0)).toBeLessThanOrEqual(
          viewport.width,
        );
        await captureUiProof(page, `group-defaults-folder-picker-${viewport.name}.png`);
      }
      await page.setViewportSize({ height: 900, width: 1280 });
      await folderPicker.getByRole("button", { name: "Use this folder" }).click();
      await expect.poll(() => folderTrigger.textContent()).toContain("client-work");
      await expect.poll(() => dialog.locator('input[name="cwd"]').count()).toBe(0);
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
