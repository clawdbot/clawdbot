import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "model-picker-refresh");

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ animations: "disabled", path: path.join(proofDir, name) });
}

suite.define(() => {
  it("keeps the warm model list interactive while a picker-open refresh is in flight", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: [
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
        { id: "fable-5", name: "Claude Fable 5", provider: "anthropic" },
      ],
      sessionKey: "main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__model-picker");
      await picker.locator("[data-chat-model-option]").first().waitFor({ state: "attached" });

      // Freeze the operator-signaled revalidation so the in-flight state is observable.
      await gateway.deferNext("models.list", { refresh: true });
      await picker.locator('[data-chat-model-select="true"]').click();
      const request = await gateway.waitForRequest("models.list");
      expect(requireRecord(request.params)).toMatchObject({ refresh: true, view: "configured" });

      // The warm list stays rendered and selectable with no refresh/loading interstitial.
      await expect
        .poll(() => picker.locator("[data-chat-model-option]:visible").count())
        .toBeGreaterThanOrEqual(3);
      await screenshot(page, "01-picker-open-refresh-in-flight.png");
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      expect(
        await picker.locator('[data-chat-model-option="openai/gpt-5.6-luna"]').isDisabled(),
      ).toBe(false);

      // The background result still owns the authoritative apply once it lands.
      await gateway.resolveDeferred("models.list", {
        models: [
          { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
          { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", provider: "openai" },
        ],
      });
      await picker
        .locator('[data-chat-model-option="openai/gpt-5.6-terra"]')
        .waitFor({ state: "visible" });
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      await screenshot(page, "02-picker-after-background-apply.png");
    } finally {
      await context.close();
    }
  });
});
