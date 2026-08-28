// Real-browser proof of frozen goal timing on the chat composer.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI goal elapsed time" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(".artifacts/control-ui-e2e/goal-elapsed");

suite.define(() => {
  it("shows a paused goal's frozen duration before and after opening details and reloading", async () => {
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    await suite.withPage(
      {
        colorScheme: "light",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
        ...(captureProof
          ? { recordVideo: { dir: artifactDir, size: { width: 1440, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: "agent:main:main",
          historyMessages: [
            {
              role: "assistant",
              content: [{ type: "text", text: "Deployment checks are ready." }],
            },
          ],
          methodResponses: {
            "sessions.list": {
              ts: 61_000,
              path: "",
              count: 1,
              defaults: { model: "gpt-5.6-luna", modelProvider: "openai", contextTokens: 128_000 },
              sessions: [
                {
                  key: "agent:main:main",
                  kind: "direct",
                  displayName: "Deployment checks",
                  updatedAt: 61_000,
                  goal: {
                    schemaVersion: 1,
                    id: "goal-timing",
                    objective: "Verify the deployment",
                    status: "paused",
                    createdAt: 1_000,
                    updatedAt: 61_000,
                    pausedAt: 61_000,
                    tokenStart: 0,
                    tokensUsed: 100,
                    continuationTurns: 0,
                  },
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat/main`);
        const goal = page.locator(".agent-chat__goal");
        await goal.getByText("Goal paused", { exact: true }).waitFor();
        if (captureProof) {
          await page.screenshot({ path: path.join(artifactDir, "paused-goal.png") });
        }
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe("1m");
        await goal.getByRole("button", { name: "Show goal details" }).click();
        expect(await goal.locator(".agent-chat__goal-detail-meta").textContent()).toContain("1m");
        await goal.getByRole("button", { name: "Hide goal details" }).click();
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe("1m");
        await page.reload();
        await goal.getByText("Goal paused", { exact: true }).waitFor();
        expect(await goal.locator(".agent-chat__goal-elapsed").textContent()).toBe("1m");
      },
    );
  });
});
