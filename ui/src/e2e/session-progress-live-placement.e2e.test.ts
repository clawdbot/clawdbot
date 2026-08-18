import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const proofDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "session-progress-live-placement",
);

async function captureProof(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, fileName),
  });
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps one live card placement and a compact transcript receipt", async () => {
    const sessionKey = "agent:main:progress-placement";
    const plan = [
      { step: "Inspect", status: "completed" },
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "pending" },
    ];

    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          historyMessages: [
            {
              id: "progress-receipt",
              role: "assistant",
              timestamp: 1,
              content: [
                {
                  type: "toolcall",
                  id: "progress-call",
                  name: "progress_card",
                  arguments: { markdown: "Implementation is moving.", plan },
                },
                {
                  type: "toolresult",
                  id: "progress-call",
                  name: "progress_card",
                  text: "Progress card updated (rev 2, 1/3 done)",
                },
              ],
            },
          ],
          methodResponses: {
            "progressCard.get": {
              card: {
                markdown: "**Implementation** is moving.",
                revision: 2,
                sessionKey,
                steps: plan,
                updatedAt: 2,
              },
            },
            "sessions.list": chatSessionListResponse([
              {
                key: sessionKey,
                kind: "direct",
                label: "Progress placement",
                updatedAt: 2,
              },
            ]),
          },
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

        const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await openChatSidePanelType(page, "Side chat");
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(0);
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);

        const receipt = visiblePane.locator(".chat-thread .chat-progress-card-receipt");
        await expect
          .poll(() => receipt.textContent())
          .toContain("Progress updated — 1/3 · Implement");
        await expect.poll(() => receipt.locator(".chat-tool-msg-body").count()).toBe(0);
        await expect
          .poll(() => visiblePane.locator(".chat-thread").textContent())
          .not.toContain("Implementation is moving.");
        await captureProof(page, "rail-visible.png");

        await page.setViewportSize({ height: 900, width: 560 });
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').count())
          .toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="rail"]').count())
          .toBe(0);
        await visiblePane.locator(".side-panel__minimize").evaluate((button) => {
          if (button instanceof HTMLElement) {
            button.click();
          }
        });
        await expect.poll(() => visiblePane.locator(".session-progress-card").count()).toBe(1);
        await expect
          .poll(() => visiblePane.locator('[data-progress-card-placement="composer"]').isVisible())
          .toBe(true);
        await captureProof(page, "composer-adjacent.png");
      },
    );
  });
});
