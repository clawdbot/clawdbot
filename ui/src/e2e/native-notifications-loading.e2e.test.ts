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
  it.each([
    { native: false, route: "chat", background: false },
    { native: true, route: "chat", background: false },
    { native: true, route: "new", background: false },
    { native: true, route: "new", background: true },
  ] as const)(
    "preserves notification startup with native=$native route=$route background=$background",
    async ({ native, route, background }) => {
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
          const gateway = await installMockGateway(page, {
            historyMessages: [],
            methodResponses: {
              "sessions.create": {
                key: "agent:main:notification-onboarding",
                initialRun: { status: "idle" },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}${route}`);
          const composer = page.locator(
            route === "new"
              ? ".new-session-page__composer textarea"
              : ".agent-chat__composer-combobox textarea",
          );
          await composer.fill("Check notification startup.");
          expect(notificationModules).toHaveLength(native ? 1 : 0);
          await page.screenshot({ path: path.join(suite.artifactDir, "ready.png") });
          if (background) {
            await expect
              .poll(() =>
                page
                  .getByRole("button", { name: "Start session", exact: true })
                  .getAttribute("aria-disabled"),
              )
              .toBe("false");
            await composer.press("Control+Enter");
          } else {
            await page
              .getByRole("button", {
                name: route === "new" ? "Start session" : "Send message",
                exact: true,
              })
              .click();
          }
          const request = await gateway.waitForRequest(
            route === "new" ? "sessions.create" : "chat.send",
          );
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
              event: background ? "keydown" : "click",
              userActivation: true,
            });
          }
          expect(notificationModules).toHaveLength(native ? 1 : 0);
          expect(errors).toEqual([]);
          await page.screenshot({ path: path.join(suite.artifactDir, "sent.png") });
        },
      );
    },
  );
});
