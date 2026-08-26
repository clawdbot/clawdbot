import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

async function captureHistoryIssuanceProof(page: Page, name: string): Promise<void> {
  const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  if (!artifactDir) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, `${name}.png`) });
}

suite.define(() => {
  it("renders a failed history load in the transcript and retries it", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      historyMessages: [
        {
          content: [{ text: "Transcript recovered after retry.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_UNAVAILABLE",
        message: "Chat history is temporarily unavailable.",
      });

      const historyError = page.locator(".chat-history-error");
      await historyError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await historyError.textContent()).toContain(
        "Chat history is temporarily unavailable.",
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await captureHistoryIssuanceProof(page, "01-history-load-failed");

      await gateway.deferNext("chat.startup");
      await historyError.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await historyError.waitFor({ state: "detached" });
      await page.locator(".chat-thread .chat-loading-skeleton").waitFor({ state: "visible" });
      await gateway.resolveDeferred("chat.startup");
      await page
        .locator(".chat-thread")
        .getByText("Transcript recovered after retry.")
        .waitFor({ state: "visible" });

      expect(await gateway.getRequests("chat.startup")).toHaveLength(2);
      expect(await page.locator(".chat-history-error").count()).toBe(0);
      await captureHistoryIssuanceProof(page, "02-history-load-retried");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("automatically resumes retryable history failures once after reconnect", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup"],
      historyMessages: [
        {
          content: [{ text: "Transcript recovered after reconnect.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_UNAVAILABLE",
        message: "Chat history will recover after reconnect.",
        retryable: true,
      });

      const historyError = page.locator(".chat-history-error");
      await historyError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await historyError.textContent()).toContain(
        "Chat history will recover after reconnect.",
      );
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

      await gateway.setOnline(false);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await page
        .locator(".chat-thread")
        .getByText("Transcript recovered after reconnect.")
        .waitFor({ state: "visible" });

      expect(await gateway.getRequests("chat.startup")).toHaveLength(2);
      expect(await page.locator(".chat-history-error").count()).toBe(0);
      await captureHistoryIssuanceProof(page, "03-history-load-auto-resumed");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it("keeps cached history visible and actionable when a refresh fails", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Cached transcript stays visible.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const cachedMessage = page
        .locator(".chat-thread")
        .getByText("Cached transcript stays visible.");
      await cachedMessage.waitFor({ state: "visible" });

      await gateway.deferNext("chat.startup");
      await gateway.setOnline(false);
      await gateway.setOnline(true);
      await gateway.waitForRequest("chat.startup", { after: 1 });
      await gateway.rejectDeferred("chat.startup", {
        code: "GATEWAY_ERROR",
        message: "History refresh failed.",
        retryable: false,
      });

      const inlineError = page.locator(".chat-history-error--inline");
      await inlineError.waitFor({ state: "visible", timeout: 5_000 });
      expect(await inlineError.textContent()).toContain("History refresh failed.");
      // The stale transcript must not be displaced by the failure surface.
      await cachedMessage.waitFor({ state: "visible" });
      await captureHistoryIssuanceProof(page, "04-history-refresh-failed-cached");

      const startupCount = (await gateway.getRequests("chat.startup")).length;
      await inlineError.getByRole("button", { name: "Retry" }).click();
      await gateway.waitForRequest("chat.startup", { after: startupCount });
      await inlineError.waitFor({ state: "hidden", timeout: 5_000 });
      await cachedMessage.waitFor({ state: "visible" });
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
