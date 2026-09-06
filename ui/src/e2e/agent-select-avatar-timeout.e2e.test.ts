// Control UI tests cover bounded authenticated agent-picker avatar fetches.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent picker avatar timeout",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-select-avatar-timeout");
  }
});

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

suite.define(() => {
  it("aborts a stalled authenticated avatar request and keeps the text fallback", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.clock.install();

      let avatarRequestCount = 0;
      let avatarAuthorization: string | undefined;
      const failedAvatarRequests: string[] = [];
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname === "/avatar/main") {
          failedAvatarRequests.push(request.failure()?.errorText ?? "unknown");
        }
      });
      await page.route(/\/avatar\/main$/, (route) => {
        avatarRequestCount += 1;
        avatarAuthorization = route.request().headers().authorization;
        // Leave the route unanswered. The page-owned deadline must cancel it.
      });
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agent.identity.get": {
            cases: [
              {
                match: { agentId: "main" },
                response: {
                  agentId: "main",
                  avatar: "/avatar/main",
                  avatarStatus: "local",
                  name: "Main agent",
                },
              },
              {
                match: { agentId: "writer" },
                response: {
                  agentId: "writer",
                  avatar: "",
                  avatarStatus: "none",
                  name: "Writer",
                },
              },
            ],
          },
          "agents.list": {
            agents: [
              { id: "main", name: "OpenClaw" },
              { id: "writer", name: "Writer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}agents`);
      expect(response?.status()).toBe(200);
      await gateway.waitForRequest("agent.identity.get");
      await expect.poll(() => avatarRequestCount).toBe(1);
      const picker = page.locator("openclaw-agent-select");
      await expect
        .poll(() =>
          picker.locator(".agent-select__avatar--text").first().getAttribute("data-avatar"),
        )
        .toBe("O");
      expect(avatarAuthorization).toBe("Bearer e2e-device-token");
      await screenshot(page, "01-request-stalled.png");

      await page.clock.runFor(30_000);
      await expect.poll(() => failedAvatarRequests.length).toBe(1);
      await expect.poll(() => picker.locator("img.agent-select__avatar").count()).toBe(0);
      await expect
        .poll(() =>
          picker.locator(".agent-select__avatar--text").first().getAttribute("data-avatar"),
        )
        .toBe("O");

      // A later render must use the cached miss instead of launching another fetch.
      await picker.locator(".agent-select__trigger").click();
      expect(avatarRequestCount).toBe(1);
      await screenshot(page, "02-timeout-fallback.png");
    });
  });
});
