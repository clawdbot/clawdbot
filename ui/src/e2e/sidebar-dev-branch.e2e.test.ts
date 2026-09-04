// Control UI sidebar footer flags non-release gateways: a source-checkout
// gateway off main reports its branch via bootstrap config and the footer
// renders it in the danger color; release gateways omit it entirely.
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar dev branch badge E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const DEV_BRANCH = "feat/dev-branch-badge";

suite.define(() => {
  it("renders the dev checkout branch in the footer in the danger color", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, { devGitBranch: DEV_BRANCH });

        const response = await page.goto(suite.server.baseUrl);
        expect(response?.status()).toBe(200);

        const badge = page.locator(".sidebar-footer-branch");
        await badge.waitFor();
        await expect
          .poll(() => badge.locator(".sidebar-footer-branch__name").textContent())
          .toBe(DEV_BRANCH);
        // The branch name surfaces via the shared tooltip's accessible
        // description instead of a native title attribute.
        await expect
          .poll(() =>
            badge.evaluate((element) => {
              const id = element.getAttribute("aria-describedby");
              return id ? (document.getElementById(id)?.textContent ?? null) : null;
            }),
          )
          .toBe(DEV_BRANCH);

        const colors = await badge.evaluate((element) => {
          // Compare resolved colors: getComputedStyle().color returns rgb() while
          // the raw --danger token may be hex/oklch, so resolve it via a probe.
          const probe = document.createElement("span");
          probe.style.color = "var(--danger)";
          element.append(probe);
          const danger = getComputedStyle(probe).color;
          probe.remove();
          return { badge: getComputedStyle(element).color, danger };
        });
        expect(colors.danger).not.toBe("");
        expect(colors.badge).toBe(colors.danger);

        const artifactDir = createControlUiE2eArtifactDir("dev-branch");
        await page
          .locator(".sidebar-shell__footer")
          .screenshot({ path: path.join(artifactDir, "footer-dev-branch.png") });
      },
    );
  });

  it("omits the badge when the gateway reports no dev branch", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page);

        const response = await page.goto(suite.server.baseUrl);
        expect(response?.status()).toBe(200);
        await page.locator(".sidebar-agent-card").waitFor();
        expect(await page.locator(".sidebar-footer-branch").count()).toBe(0);
      },
    );
  });
});
