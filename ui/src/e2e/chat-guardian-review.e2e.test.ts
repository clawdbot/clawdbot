import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Guardian strict review mocked Gateway E2E",
  trackBrowserContexts: true,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureProof) {
    proofDir = createControlUiE2eArtifactDir("codex-guardian-review");
  }
});
const viewport = { height: 900, width: 1280 };

suite.define(() => {
  it("shows and settles a strict Guardian review in the active chat", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        ...(captureProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            {
              content: [{ text: "Ready for a Guardian-reviewed action.", type: "text" }],
              role: "assistant",
              timestamp: Date.now(),
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Ready for a Guardian-reviewed action.").waitFor();
        await page.locator(".agent-chat__composer-combobox textarea").fill("Review this action.");
        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        const runId = requireString(requireRecord(request.params).idempotencyKey, "chat run id");

        if (captureProof) {
          await writeFile(
            path.join(proofDir, "01-before-review.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".agent-chat__composer-combobox textarea"),
            ]),
          );
        }

        const correlation = {
          reviewId: "guardian-review-1",
          threadId: "codex-thread-1",
          turnId: "codex-turn-1",
        };
        await gateway.emitGatewayEvent("agent", {
          data: {
            ...correlation,
            phase: "strict_review_required",
            startedAtMs: Date.now(),
          },
          runId,
          seq: 1,
          sessionKey: "main",
          stream: "codex_app_server.guardian",
          ts: Date.now(),
        });

        const notice = page.getByRole("alert").filter({ hasText: "Guardian review required" });
        await notice.waitFor({ state: "visible" });
        expect(await notice.textContent()).toContain(
          "Guardian is reviewing this action before it can continue.",
        );

        if (captureProof) {
          await writeFile(
            path.join(proofDir, "02-review-required.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [notice]),
          );
        }

        await gateway.emitGatewayEvent("agent", {
          data: { ...correlation, phase: "completed", status: "approved" },
          runId,
          seq: 2,
          sessionKey: "main",
          stream: "codex_app_server.guardian",
          ts: Date.now(),
        });
        await expect.poll(() => notice.count()).toBe(0);

        if (captureProof) {
          await writeFile(
            path.join(proofDir, "03-review-approved.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
              page.locator(".agent-chat__composer-combobox textarea"),
            ]),
          );
        }
      },
    );
  });
});
