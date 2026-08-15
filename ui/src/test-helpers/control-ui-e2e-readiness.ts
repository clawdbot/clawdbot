import type { Page } from "playwright";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e.ts";

/** A sent connect request is not the delivered Gateway handshake. */
export async function waitForControlUiGatewayReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const app = document.querySelector("openclaw-app") as
      | (HTMLElement & { runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } } })
      | null;
    return app?.runtime?.context?.gateway?.snapshot?.phase === "connected";
  });
}

/** Wait for both the Gateway lifecycle and its dedicated visible reconnect status. */
export async function waitForControlUiGatewayReconnecting(page: Page): Promise<void> {
  await Promise.all([
    page.waitForFunction(
      () => {
        const app = document.querySelector("openclaw-app") as
          | (HTMLElement & {
              runtime?: { context?: { gateway?: { snapshot?: { phase?: string } } } };
            })
          | null;
        return app?.runtime?.context?.gateway?.snapshot?.phase === "reconnecting";
      },
      undefined,
      { timeout: controlUiE2eWaitTimeoutMs },
    ),
    page
      .locator(".sidebar-identity-card__status", { hasText: "Reconnecting…" })
      .waitFor({ state: "visible", timeout: controlUiE2eWaitTimeoutMs }),
  ]);
}

/** Wait for the lazy terminal itself before exercising a real keyboard shortcut. */
export async function waitForControlUiTerminalReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        document.querySelector("openclaw-terminal-panel") as
          | (HTMLElement & { available?: boolean })
          | null
      )?.available === true,
  );
}
