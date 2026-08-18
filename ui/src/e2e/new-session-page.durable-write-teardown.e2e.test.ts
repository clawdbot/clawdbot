import path from "node:path";
import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("starts an attachment write while an earlier text write is still pending", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    try {
      const text = "keep the attachment added during the pending text write";
      const fileName = "favicon-32.png";
      const firstPage = await context.newPage();
      await firstPage.addInitScript(() => {
        const originalGet = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "get")
          ?.value as IDBObjectStore["get"];
        let blocked = false;
        IDBObjectStore.prototype.get = function (query: IDBValidKey | IDBKeyRange) {
          if (!blocked && this.name === "composerDrafts") {
            blocked = true;
            (globalThis as unknown as { firstDraftReadBlocked: boolean }).firstDraftReadBlocked =
              true;
            return new EventTarget() as IDBRequest;
          }
          return originalGet.call(this, query);
        };
      });
      await installMockGateway(firstPage);
      await firstPage.goto(`${suite.server.baseUrl}new`);
      await firstPage.locator(".new-session-page__message").fill(text);
      await expect
        .poll(() =>
          firstPage.evaluate(
            () =>
              (globalThis as unknown as { firstDraftReadBlocked?: boolean })
                .firstDraftReadBlocked === true,
          ),
        )
        .toBe(true);

      await firstPage
        .locator(".agent-chat__photo-input")
        .setInputFiles(path.join(process.cwd(), "ui/public/favicon-32.png"));
      await firstPage.getByRole("button", { name: `Open image ${fileName}` }).waitFor();
      await firstPage.close();

      const restoredPage = await context.newPage();
      await installMockGateway(restoredPage);
      await restoredPage.goto(`${suite.server.baseUrl}new`);
      await expect
        .poll(() => restoredPage.locator(".new-session-page__message").inputValue())
        .toBe(text);
      await restoredPage.getByRole("button", { name: `Open image ${fileName}` }).waitFor();
    } finally {
      await context.close();
    }
  });
});
