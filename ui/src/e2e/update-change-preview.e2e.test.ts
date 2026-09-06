import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createUpdateRunFixture } from "./update-run.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Update change preview E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([1280, 390])("shows changes before updating at width %i", async (width) => {
    const proof = createControlUiE2eArtifactDir("update-change-preview");
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width, height: 844 } },
      async ({ page }) => {
        const subjects = [
          "feat: preview available changes before updating",
          "fix: preserve session state during reconnect",
          "fix: improve keyboard navigation in Settings",
          "docs: clarify update recovery guidance",
          "chore: refresh development tooling",
        ];
        const run = createUpdateRunFixture();
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.admin", "operator.read"],
          updateAvailable: {
            channel: "dev",
            currentVersion: "2026.9.1",
            latestVersion: "2026.9.1",
            currentSha: "1111111",
            upstreamRef: "origin/main",
            upstreamSha: "abcdef0",
            commitsBehind: 6,
            commits: subjects.map((subject, index) => ({ sha: `abc123${index}`, subject })),
          },
          methodResponses: {
            "update.run": { ok: true, runId: run.runId, restart: null, result: { status: "ok" } },
            "update.runs.get": { run },
          },
        });
        expect((await page.goto(`${suite.server.baseUrl}chat`))?.status()).toBe(200);
        await gateway.waitForRequest("chat.startup");
        if (width < 640) {
          await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        }
        await page.locator(".sidebar-issues-button:visible").click();
        const card = page.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        await card.locator("summary").click();
        await card.getByText("Showing 5 of 6 commits", { exact: true }).waitFor();
        expect(await card.locator(".update-change-preview li").count()).toBe(5);
        await page.screenshot({
          path: path.join(proof, `inbox-${width}.png`),
          animations: "disabled",
        });
        const action = card.locator(".sidebar-update-card__action");
        await action.click();
        const modal = page.locator("openclaw-modal-dialog");
        await modal.getByText("Showing 5 of 6 commits", { exact: true }).waitFor();
        for (const subject of subjects) {
          expect(await modal.textContent()).toContain(subject);
        }
        await page.screenshot({
          path: path.join(proof, `confirmation-${width}.png`),
          animations: "disabled",
        });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await modal.getByRole("button", { name: "Cancel", exact: true }).click();
        await modal.waitFor({ state: "detached" });
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        // Opening the confirmation closes the Inbox popover.
        await page.locator(".sidebar-issues-button:visible").click();
        await card.locator("summary").click();
        await action.click();
        await modal.getByRole("button", { name: "Update and restart", exact: true }).click();
        await gateway.waitForRequest("update.run");
        expect(await gateway.getRequests("update.run")).toHaveLength(1);
      },
    );
  });
});
