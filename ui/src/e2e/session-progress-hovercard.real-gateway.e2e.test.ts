import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { getActivePluginRegistry } from "../../../src/plugins/runtime.ts";
import type { SessionCatalogProvider } from "../../../src/plugins/session-catalog.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

declare global {
  interface Window {
    catalogProgressRequests?: Array<{ outcome: "error" | "ok"; sessionKey: string }>;
  }
}

const suite = createControlUiE2eSuite({
  name: "Control UI catalog progress hovercard with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const threadId = "00000000-0000-0000-0000-000000135156";
const routeAgentId = "writer";
const catalogSessionKey = `agent:${routeAgentId}:catalog:codex:gateway%3Alocal:${threadId}`;

suite.define(() => {
  it("keeps the selected agent on native catalog progress-card requests", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-catalog-progress",
      layout: "home",
      env: {
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
    let removeCatalogRegistration: (() => void) | undefined;
    try {
      const mainWorkspace = state.path("workspace-main");
      const writerWorkspace = state.path("workspace-writer");
      await Promise.all([
        mkdir(mainWorkspace, { recursive: true }),
        mkdir(writerWorkspace, { recursive: true }),
      ]);
      await state.writeConfig({
        agents: {
          defaults: { workspace: mainWorkspace },
          ownership: "explicit",
          entries: {
            main: { name: "Main", workspace: mainWorkspace },
            [routeAgentId]: { name: "Writer", workspace: writerWorkspace },
          },
        },
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      const provider: SessionCatalogProvider = {
        id: "codex",
        label: "Codex",
        list: async () => [
          {
            hostId: "gateway:local",
            label: "Local Codex",
            kind: "gateway",
            connected: true,
            sessions: [
              {
                threadId,
                name: "Native catalog progress",
                cwd: writerWorkspace,
                status: "idle",
                archived: false,
                canContinue: false,
                canArchive: false,
              },
            ],
          },
        ],
        read: async ({ hostId, threadId: requestedThreadId }) => ({
          hostId,
          threadId: requestedThreadId,
          items: [],
        }),
      };
      const activeRegistry = getActivePluginRegistry();
      if (!activeRegistry) {
        throw new Error("Gateway plugin registry is unavailable");
      }
      // The real Gateway advertises catalog methods from this startup-owned registry object.
      const registration = { pluginId: "codex", provider, source: import.meta.url };
      activeRegistry.sessionCatalogs.push(registration);
      removeCatalogRegistration = () => {
        const index = activeRegistry.sessionCatalogs.indexOf(registration);
        if (index >= 0) {
          activeRegistry.sessionCatalogs.splice(index, 1);
        }
      };

      const artifactDir = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1" ? suite.artifactDir : null;
      await suite.withPage(
        {
          hasTouch: false,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
        },
        async ({ page }) => {
          const url = new URL(`chat/${routeAgentId}`, suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation
            .getByRole("button", { name: `Switch to 127.0.0.1:${port}`, exact: true })
            .click();

          const row = page.locator(
            '[data-session-section="catalog:codex"] .sidebar-recent-session',
            {
              hasText: "Native catalog progress",
            },
          );
          await row.waitFor({ state: "visible", timeout: 30_000 });
          if (artifactDir) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(artifactDir, "01-native-catalog-row.png"),
            });
          }
          expect(await row.getAttribute("data-session-key")).toBe(catalogSessionKey);
          await page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime: {
                context: { gateway: { snapshot: { client: GatewayBrowserClient | null } } };
              };
            };
            const client = app.runtime.context.gateway.snapshot.client;
            if (!client) {
              throw new Error("Control UI Gateway client is unavailable");
            }
            const request = client.request.bind(client);
            const observed: Array<{ outcome: "error" | "ok"; sessionKey: string }> = [];
            window.catalogProgressRequests = observed;
            client.request = async <T>(method: string, params?: unknown): Promise<T> => {
              if (method !== "progressCard.get") {
                return await request<T>(method, params);
              }
              const sessionKey = (params as { sessionKey: string }).sessionKey;
              try {
                const result = await request<T>(method, params);
                observed.push({ outcome: "ok", sessionKey });
                return result;
              } catch (error) {
                observed.push({ outcome: "error", sessionKey });
                throw error;
              }
            };
          });
          await row.locator("a.sidebar-recent-session__link").focus();
          const card = page.locator(".session-progress-hovercard");
          await card.waitFor({ state: "visible" });
          await expect
            .poll(() => page.evaluate(() => window.catalogProgressRequests))
            .toEqual([{ outcome: "ok", sessionKey: catalogSessionKey }]);
          await expect.poll(() => card.textContent()).toContain("Native catalog progress");
          if (artifactDir) {
            await page.screenshot({
              animations: "disabled",
              fullPage: true,
              path: path.join(artifactDir, "02-qualified-progress-card.png"),
            });
          }
        },
      );
    } finally {
      removeCatalogRegistration?.();
      try {
        await gateway?.close({ reason: "catalog progress hovercard e2e cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});
