import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const SESSION_KEY = "agent:main:transition-proof-0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "new-session-transition");

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, fileName) });
}

suite.define(() => {
  it("keeps startup progress active while preparing the exact chat route", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    let releaseChatModule!: () => void;
    let chatModuleRequested = false;
    const chatModuleBlocked = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route("**/assets/chat-page-*.js*", async (route) => {
      chatModuleRequested = true;
      await chatModuleBlocked;
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": { key: SESSION_KEY, runStarted: true },
        "sessions.list": createdSessionListResult(SESSION_KEY),
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      const start = page.locator(".new-session-page__start-submit");
      await message.fill("keep progress moving");
      await expect.poll(() => start.isEnabled()).toBe(true);

      await gateway.deferNext("sessions.create");
      await start.click();
      await gateway.waitForRequest("sessions.create");
      await gateway.resolveDeferred("sessions.create", {
        key: SESSION_KEY,
        runStarted: true,
      });
      await expect.poll(() => chatModuleRequested).toBe(true);

      await expect.poll(() => start.getAttribute("aria-busy")).toBe("true");
      await captureProof(page, "01-chat-route-preparing.png");

      releaseChatModule();
      await waitForCommittedChatRoute(page);
      await page.locator("openclaw-chat-page").waitFor();
      await captureProof(page, "02-chat-route-ready.png");
    } finally {
      releaseChatModule();
      await context.close();
    }
  });
});
