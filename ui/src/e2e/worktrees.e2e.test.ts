// Control UI tests cover Worktrees mutation failures through the rendered settings page.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Worktrees mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const restorableWorktree = {
  baseRef: "main",
  branch: "openclaw/test",
  createdAt: 1,
  id: "worktree-1",
  lastActiveAt: 2,
  name: "restorable-test",
  ownerKind: "manual",
  path: "/tmp/repo/.worktrees/restorable-test",
  removedAt: 3,
  repoFingerprint: "0123456789abcdef",
  repoRoot: "/tmp/repo",
  snapshotRef: "refs/openclaw/worktree-snapshots/test",
};

suite.define(() => {
  it("keeps a restore failure visible after the automatic list refresh succeeds", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["worktrees.restore"],
        methodResponses: {
          "worktrees.list": { worktrees: [restorableWorktree] },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}settings/worktrees`);
      expect(response?.status()).toBe(200);
      await page.getByRole("button", { name: "Restore" }).click();
      await gateway.waitForRequest("worktrees.restore");
      await gateway.rejectDeferred("worktrees.restore", {
        message: "source repository is unavailable",
      });

      await expect
        .poll(async () => (await gateway.getRequests("worktrees.list")).length)
        .toBeGreaterThanOrEqual(2);
      await expect(page.locator(".callout.danger").textContent()).resolves.toContain(
        "source repository is unavailable",
      );
      await expect(page.getByRole("alert").count()).resolves.toBe(1);
      await expect(page.getByRole("button", { name: "Restore" }).count()).resolves.toBe(1);
    });
  });
});
