import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("does not resurrect a reveal failure after navigating away", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.startup", "sessions.files.reveal"],
      historyMessages: [{ role: "assistant", content: "Session outcome proof." }],
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: sessionA,
            kind: "direct",
            label: "Session A",
            spawnedCwd: "/workspace/session-a",
            updatedAt: 2,
          },
          {
            key: sessionB,
            kind: "direct",
            label: "Session B",
            spawnedCwd: "/workspace/session-b",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.deferNext("sessions.files.reveal");
      await page.getByRole("button", { name: "Workspace actions for session-a" }).click();
      await page.getByRole("menuitem", { name: "Open in file manager" }).click();
      await gateway.waitForRequest("sessions.files.reveal");

      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionB}"] a.sidebar-recent-session__link`,
        )
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionB));
      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--visible")
            .evaluate((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey),
        )
        .toBe(sessionB);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${sessionA}"] a.sidebar-recent-session__link`,
        )
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
      await expect
        .poll(() =>
          page
            .locator(".chat-pane-cache__pane--visible")
            .evaluate((pane) => (pane as HTMLElement & { sessionKey?: string }).sessionKey),
        )
        .toBe(sessionA);
      await gateway.resolveDeferred("sessions.files.reveal", {
        ok: false,
        error: "Stale reveal failure must stay retired.",
      });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await expect
        .poll(() => page.getByText("Stale reveal failure must stay retired.").count())
        .toBe(0);
      await expect
        .poll(() =>
          page.locator(".chat-pane-cache__pane--visible").evaluate((pane) => {
            return (pane as HTMLElement & { state?: { chatError?: string | null } }).state
              ?.chatError;
          }),
        )
        .not.toBe("Stale reveal failure must stay retired.");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
