// Control UI proof against an isolated real Gateway and trusted user identity.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { ensureProfileForEmail, setDisplayName } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI profile page real Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const authenticatedUser = "primary.user@example.test";

suite.define(() => {
  it("shows the authenticated user instead of the default agent through a real Gateway", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-profile-real-gateway",
      layout: "home",
      env: {
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    try {
      const clipperWorkspace = state.path("workspace-clipper");
      await mkdir(clipperWorkspace, { recursive: true });
      const profile = ensureProfileForEmail(authenticatedUser);
      setDisplayName(profile.id, "Test Person");
      const trustedProxy = {
        allowLoopback: true,
        allowUsers: [authenticatedUser],
        deviceAutoApprove: {
          enabled: true,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
        requiredHeaders: ["x-forwarded-proto"],
        userHeader: "x-forwarded-user",
      };
      await state.writeConfig({
        agents: {
          defaults: { workspace: state.workspaceDir },
          entries: {
            main: { name: "Main", workspace: state.workspaceDir },
            clipper: { default: true, name: "Clipper", workspace: clipperWorkspace },
          },
        },
        gateway: {
          auth: { mode: "trusted-proxy", trustedProxy },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
          trustedProxies: ["127.0.0.1", "::1"],
        },
      });
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "trusted-proxy", trustedProxy },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      // Chromium does not consistently apply extraHTTPHeaders to WebSocket upgrades.
      proxy = await createServer({
        configFile: false,
        envFile: false,
        root: state.workspaceDir,
        appType: "custom",
        logLevel: "error",
        server: {
          host: "127.0.0.1",
          port: 0,
          proxy: {
            "/": {
              target: `http://127.0.0.1:${port}`,
              ws: true,
              headers: {
                "x-forwarded-for": "192.0.2.10",
                "x-forwarded-proto": "http",
                "x-forwarded-user": authenticatedUser,
              },
            },
          },
        },
      });
      await proxy.listen();
      const proxyUrl = proxy.resolvedUrls?.local[0];
      if (!proxyUrl) {
        throw new Error("Profile test proxy did not expose a loopback URL");
      }
      const gatewayUrl = new URL(proxyUrl);
      gatewayUrl.protocol = "ws:";

      const proofDir = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? suite.artifactDir : null;
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 800, width: 1280 },
          ...(proofDir
            ? { recordVideo: { dir: proofDir, size: { height: 800, width: 1280 } } }
            : {}),
        },
        async ({ page }) => {
          const url = new URL("settings/profile", suite.server.baseUrl);
          url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
          const response = await page.goto(url.href);
          expect(response?.status()).toBe(200);
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to ${gatewayUrl.host}`, exact: true })
            .click();
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Test Person");
          await expect
            .poll(() => page.locator(".profile-hero__handle").textContent())
            .toContain(authenticatedUser);
          await expect
            .poll(() => page.locator(".profile-hero").textContent())
            .not.toContain("Clipper");
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "01-real-gateway-authenticated-profile.png"),
            });
          }
          await page.locator(".identity-name-control input").fill("Local draft");
          const editor = await page.context().newPage();
          await editor.goto(new URL("settings/profile", suite.server.baseUrl).href);
          const nameInput = editor.locator(".identity-name-control input");
          await expect.poll(() => nameInput.inputValue()).toBe("Test Person");
          await nameInput.fill("Remote Person");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe("Remote Person");
          await nameInput.fill("");
          await nameInput.press("Enter");
          await expect
            .poll(() => page.locator(".profile-hero__name").textContent())
            .toBe(authenticatedUser);
          await expect
            .poll(() => page.locator(".identity-name-control input").inputValue())
            .toBe("Local draft");
          if (proofDir) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "02-real-gateway-cleared-profile.png"),
            });
          }
        },
      );
    } finally {
      try {
        await proxy?.close();
      } finally {
        try {
          await gateway?.close({ reason: "profile real Gateway e2e cleanup" });
        } finally {
          await state.cleanup();
        }
      }
    }
  });
});
