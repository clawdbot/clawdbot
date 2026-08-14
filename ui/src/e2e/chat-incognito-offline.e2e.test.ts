import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const SESSION_KEY = "agent:main:dashboard:incognito-offline-proof";

suite.define(() => {
  it("keeps the incognito indicator while the Gateway is offline", async () => {
    const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
    const shot = async (name: string) => {
      if (artifactDir) {
        await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
      }
    };

    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: SESSION_KEY,
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            incognito: true,
            key: SESSION_KEY,
            kind: "direct",
            label: "Incognito",
            updatedAt: 2,
          },
        ]),
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, SESSION_KEY));
      const incognito = page.locator(".chat-pane__incognito");
      const offlineHint = page.locator(".agent-chat__offline-hint");
      await page.locator(".agent-chat__composer-combobox textarea").waitFor({ timeout: 10_000 });
      await incognito.waitFor({ timeout: 10_000 });
      await shot("01-incognito-connected");

      // Losing the Gateway clears the roster the pane used to describe this
      // session. The session did not stop being incognito, so the indicator has
      // to outlive the roster, and it has to coexist with the offline warning.
      await gateway.setOnline(false);
      await offlineHint.waitFor({ timeout: 10_000 });
      expect(await incognito.count()).toBe(1);
      await shot("02-incognito-and-offline");

      await gateway.setOnline(true);
      await offlineHint.waitFor({ state: "detached", timeout: 15_000 });
      expect(await incognito.count()).toBe(1);
      await shot("03-incognito-reconnected");
    } finally {
      await context.close();
    }
  });
});
