import path from "node:path";
import { expect, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser bootstrap" });

suite.define(() => {
  it("recovers a bare HTTPS deep link and reuses the paired browser credential on reload", async () => {
    const artifactDir = suite.artifactDir;
    const video = await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        locale: "en-US",
        serviceWorkers: "block",
        recordVideo: { dir: artifactDir, size: { width: 1440, height: 1000 } },
      },
      async ({ page }) => {
        const origin = "https://gateway.example";
        const sessionKey = "agent:main:browser-bootstrap-proof";
        const deepLink = `${controlUiSessionUrl(`${origin}/`, sessionKey)}?keep=yes#section`;
        const bootstrapToken = "synthetic-owner-bootstrap";
        const deviceToken = "synthetic-paired-browser";
        let helperCalls = 0;
        let releaseHandoff!: () => void;
        const handoffReady = new Promise<void>((resolve) => {
          releaseHandoff = resolve;
        });

        // Exercise secure-origin browser behavior while serving only this test's local bundle.
        await page.route(`${origin}/**`, async (route) => {
          const requested = new URL(route.request().url());
          const upstream = new URL(
            `${requested.pathname}${requested.search}`,
            suite.server.baseUrl,
          );
          const response = await route.fetch({ url: upstream.href });
          await route.fulfill({ response });
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          deviceToken,
          heldMethods: ["connect"],
          historyMessages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Your browser is connected. This is synthetic proof data." },
              ],
            },
          ],
        });
        await page.route(`${origin}/.well-known/openclaw/browser-bootstrap`, async (route) => {
          helperCalls += 1;
          expect(route.request().method()).toBe("GET");
          expect(route.request().headers().authorization).toBeUndefined();
          await handoffReady;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: { "Cache-Control": "no-store" },
            body: JSON.stringify({ bootstrapToken, bootstrapProfile: "owner" }),
          });
        });

        await page.goto(deepLink);
        const initialConnect = await gateway.waitForRequest("connect");
        expect(initialConnect.params).not.toHaveProperty("auth.bootstrapToken");
        expect(initialConnect.params).not.toHaveProperty("auth.deviceToken");
        await gateway.rejectDeferred("connect", {
          code: "INVALID_REQUEST",
          message: "The Gateway needs a matching token or password.",
          details: { code: ConnectErrorDetailCodes.AUTH_TOKEN_MISSING },
        });
        await page.getByText("Auth required", { exact: true }).waitFor();
        await expect.poll(() => helperCalls).toBe(1);
        await page.screenshot({ path: path.join(artifactDir, "1-auth-required.png") });

        await gateway.deferNext("connect");
        releaseHandoff();
        const recoveredConnect = await gateway.waitForRequest("connect", { after: 1 });
        expect(recoveredConnect.params).toMatchObject({
          auth: { bootstrapToken },
          device: { id: expect.any(String), signature: expect.any(String) },
        });
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        await page
          .getByText("Your browser is connected. This is synthetic proof data.", { exact: true })
          .waitFor();
        expect(page.url()).toBe(deepLink);
        await page.screenshot({ path: path.join(artifactDir, "2-connected.png") });

        await page.reload();
        const reloadConnect = await gateway.waitForRequest("connect");
        expect(reloadConnect.params).toMatchObject({ auth: { deviceToken } });
        expect(reloadConnect.params).not.toHaveProperty("auth.bootstrapToken");
        await gateway.resolveDeferred("connect");
        await waitForControlUiGatewayReady(page);
        await page
          .getByText("Your browser is connected. This is synthetic proof data.", { exact: true })
          .waitFor();
        expect(helperCalls).toBe(1);
        expect(page.url()).toBe(deepLink);
        await page.screenshot({ path: path.join(artifactDir, "3-reloaded.png") });
        return page.video();
      },
    );
    await video?.saveAs(path.join(artifactDir, "browser-bootstrap.webm"));
  });
});
