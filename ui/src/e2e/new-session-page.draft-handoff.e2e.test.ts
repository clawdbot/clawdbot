import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  installMockGateway,
  waitForCommittedNewSessionDraft,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("lets a newer durable prompt and file beat a stale navigation handoff", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const sessionKey = "agent:main:existing-session";
      const staleText = "stale draft from the first page";
      const durableText = "newer durable draft from the second page";
      const staleFileName = "favicon-32.png";
      const durableFileName = "apple-touch-icon.png";
      const pageA = await context.newPage();
      await installMockGateway(pageA, {
        methodResponses: {
          "sessions.list": createdSessionListResult(sessionKey),
        },
      });
      await pageA.goto(`${suite.server.baseUrl}chat`);
      const existingSession = pageA
        .locator(".sidebar-recent-session")
        .filter({ hasText: "Created session" });
      await existingSession.waitFor();
      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );

      const messageA = pageA.locator(".new-session-page__message");
      await messageA.fill(staleText);
      await pageA
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await pageA.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();
      await captureUiProof(pageA, "new-session-draft-before-navigation.png");

      await existingSession.click();
      await pageA.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey));

      const pageB = await context.newPage();
      await installMockGateway(pageB);
      await pageB.goto(`${suite.server.baseUrl}new?agent=main`);
      const messageB = pageB.locator(".new-session-page__message");
      await expect.poll(() => messageB.inputValue()).toBe(staleText);
      await pageB.getByRole("button", { name: `Open image ${staleFileName}` }).waitFor();

      await messageB.fill(durableText);
      await pageB.getByRole("button", { name: "Remove attachment" }).click();
      await pageB
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      await pageB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await waitForCommittedNewSessionDraft(pageB, durableText, [durableFileName]);
      await pageB.reload();
      await expect.poll(() => messageB.inputValue()).toBe(durableText);
      await pageB.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        pageB.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await pageB.close();

      await pageA.locator(".sidebar-brand__new-thread").click();
      await pageA.waitForURL(
        (url) => url.pathname.endsWith("/new") && url.search === "?agent=main",
      );
      await expect.poll(() => messageA.inputValue()).toBe(durableText);
      await pageA.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        pageA.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
      await captureUiProof(pageA, "new-session-draft-restored.png");
      await pageA.close();

      const freshPage = await context.newPage();
      await installMockGateway(freshPage);
      await freshPage.goto(`${suite.server.baseUrl}new?agent=main`);
      await expect
        .poll(() => freshPage.locator(".new-session-page__message").inputValue())
        .toBe(durableText);
      await freshPage.getByRole("button", { name: `Open image ${durableFileName}` }).waitFor();
      await expect(
        freshPage.getByRole("button", { name: `Open image ${staleFileName}` }).count(),
      ).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });
});
