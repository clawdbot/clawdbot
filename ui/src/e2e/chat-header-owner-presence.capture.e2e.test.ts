import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI chat header owner presence capture",
  startServerBeforeBrowser: true,
});

const outputDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_CHAT_HEADER_CAPTURE_OUTPUT_DIR ??
    ".artifacts/control-ui-e2e/chat-header-owner-presence",
);
const screenshotPath = path.join(outputDir, "chat-header.png");

suite.define(() => {
  it("captures the owner chip with another active viewer", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 760, width: 1180 },
      },
      async ({ page }) => {
        const sessionKey = "agent:main:owner-present";
        await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            { self: true, id: "profile-operator", name: "Operator" },
            {
              id: "profile-ada",
              name: "Ada",
              watchedSessions: [sessionKey],
            },
            {
              id: "profile-zoe",
              name: "Zoe",
              watchedSessions: [sessionKey],
            },
          ],
          sessionKey,
          methodResponses: {
            "sessions.list": {
              count: 1,
              owners: [
                { type: "human", id: "profile-ada", label: "Ada" },
                { type: "human", id: "profile-zoe", label: "Zoe" },
              ],
              defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
              path: "",
              sessions: [
                {
                  contextTokens: null,
                  createdActor: { type: "human", id: "profile-ada", label: "Ada" },
                  owner: {
                    actor: { type: "human", id: "profile-ada", label: "Ada" },
                  },
                  displayName: "Owner presence",
                  hasActiveRun: false,
                  key: sessionKey,
                  kind: "direct",
                  label: "Owner presence",
                  model: "gpt-5.5",
                  modelProvider: "openai",
                  status: "done",
                  totalTokens: 0,
                  updatedAt: Date.parse("2026-08-14T12:00:00.000Z"),
                },
              ],
              ts: Date.parse("2026-08-14T12:00:00.000Z"),
            },
          },
        });

        const response = await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        expect(response?.status()).toBe(200);
        const header = page.locator(".chat-pane__header").first();
        await header.waitFor({ state: "visible" });
        await expect.poll(() => header.locator(".session-owner-chip--header").count()).toBe(1);
        await expect
          .poll(() => header.locator(".viewer-facepile").getAttribute("data-viewer-count"))
          .toBe("1");
        await expect.poll(() => header.locator('[data-viewer-id="profile-ada"]').count()).toBe(0);
        await expect.poll(() => header.locator('[data-viewer-id="profile-zoe"]').count()).toBe(1);
        await expect
          .poll(() => header.locator(".session-owner-chip--header").getAttribute("class"))
          .not.toContain("session-owner-chip--away");

        const clip = await header.boundingBox();
        if (!clip) {
          throw new Error("Chat header did not expose a screenshot bounding box");
        }
        await mkdir(outputDir, { recursive: true });
        await page.screenshot({ animations: "disabled", clip, path: screenshotPath });
        process.stdout.write(`Chat header screenshot: ${screenshotPath}\n`);
      },
    );
  });
});
