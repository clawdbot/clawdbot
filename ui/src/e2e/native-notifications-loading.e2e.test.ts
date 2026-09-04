import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

type NotificationProof = {
  type: string;
  event: string | null;
  userActivation: boolean;
};

const suite = createControlUiE2eSuite({
  name: "Native notification loading",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it.each([false, true])("loads notifications only for a native host: %s", async (native) => {
    const viewport = { width: 1360, height: 1000 };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport,
        recordVideo: { dir: suite.artifactDir, size: viewport },
      },
      async ({ page }) => {
        const notificationModules: string[] = [];
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (new URL(request.url()).pathname.endsWith("/app/native-notifications.ts")) {
            notificationModules.push(request.url());
          }
        });
        if (native) {
          await page.addInitScript(() => {
            const messages: NotificationProof[] = [];
            Object.assign(window, {
              notificationProof: messages,
              __OPENCLAW_NATIVE_NOTIFICATIONS__: { permission: "notDetermined" },
              webkit: {
                messageHandlers: {
                  openclawNotifications: {
                    postMessage(message: { type: string }) {
                      messages.push({
                        type: message.type,
                        event: window.event?.type ?? null,
                        userActivation: navigator.userActivation.isActive,
                      });
                    },
                  },
                },
              },
            });
          });
        }
        const gateway = await installMockGateway(page, { historyMessages: [] });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Check notification startup.");
        expect(notificationModules).toHaveLength(native ? 1 : 0);
        await page.screenshot({ path: path.join(suite.artifactDir, "ready.png") });
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params).toMatchObject({ message: "Check notification startup." });
        if (native) {
          const messages = await page.evaluate(
            () =>
              (window as typeof window & { notificationProof: NotificationProof[] })
                .notificationProof,
          );
          expect(messages).toContainEqual({ type: "status", event: null, userActivation: false });
          expect(messages).toContainEqual({
            type: "request-permission",
            event: "click",
            userActivation: true,
          });
        }
        expect(notificationModules).toHaveLength(native ? 1 : 0);
        expect(errors).toEqual([]);
        await page.screenshot({ path: path.join(suite.artifactDir, "sent.png") });
      },
    );
  });
});
