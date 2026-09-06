import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI lazy route error layout",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const initialSessionKey = "agent:main:main";
const failedSessionKey = "agent:main:error-panel";
const gatewayError = "Authenticated profile verification is unavailable; retry the request.";

suite.define(() => {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    it(`keeps a retained-route error compact and centered on ${viewport.name}`, async () => {
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, { sessionKey: initialSessionKey });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, initialSessionKey));
          await page.locator("openclaw-chat-pane").waitFor();

          await gateway.setMethodResponse("sessions.resolve", {
            __mockError: { code: "UNAVAILABLE", message: gatewayError },
          });
          const pathname = controlUiSessionPath(failedSessionKey);
          await page.evaluate((targetPathname) => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: {
                context: {
                  navigate: (routeId: string, options: { pathname: string }) => void;
                };
              };
            };
            if (!app.runtime) {
              throw new Error("OpenClaw application runtime is unavailable");
            }
            app.runtime.context.navigate("chat", { pathname: targetPathname });
          }, pathname);

          const error = page.locator(".lazy-view-error");
          await error.getByText("Panel failed to load", { exact: true }).waitFor();
          await error.getByText(gatewayError, { exact: true }).waitFor();
          const layout = await error.evaluate((node) => {
            const content = [
              ".lazy-view-error__icon",
              ".lazy-view-error__title",
              ".lazy-view-error__subtitle",
              ".lazy-view-error__actions",
              ".lazy-view-error__detail",
            ].map((selector) => {
              const element = node.querySelector(selector);
              if (!(element instanceof HTMLElement)) {
                throw new Error(`Missing ${selector}`);
              }
              return element.getBoundingClientRect();
            });
            const container = node.getBoundingClientRect();
            const button = node.querySelector("button")?.getBoundingClientRect();
            return {
              buttonHeight: button?.height ?? 0,
              containerCenter: container.top + container.height / 2,
              groupBottom: Math.max(...content.map((bounds) => bounds.bottom)),
              groupTop: Math.min(...content.map((bounds) => bounds.top)),
            };
          });
          const groupCenter = (layout.groupTop + layout.groupBottom) / 2;

          expect(layout.buttonHeight).toBeLessThanOrEqual(48);
          expect(layout.groupBottom - layout.groupTop).toBeLessThanOrEqual(320);
          expect(Math.abs(groupCenter - layout.containerCenter)).toBeLessThanOrEqual(1);
        },
      );
    });
  }
});
