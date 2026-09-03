import path from "node:path";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI settings loading skeletons mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
});

const proofStage = process.env.OPENCLAW_UI_PROOF_STAGE ?? "after";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const captureBeforeProof = captureUiProof && proofStage === "before";

async function captureScreenshot(
  target: import("playwright").Locator,
  name: string,
): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await target.screenshot({
    animations: "disabled",
    path: path.join(suite.artifactDir, `${proofStage}-${name}.png`),
  });
}

async function captureLoadingState(
  target: import("playwright").Locator,
  name: string,
): Promise<void> {
  await target.waitFor({ state: "visible" });
  await captureScreenshot(target, name);
  if (captureBeforeProof) {
    return;
  }
  const skeletons = target.locator(".settings-loading-skeleton");
  await expect.poll(() => skeletons.count()).toBeGreaterThan(0);
  expect(await target.textContent()).not.toContain("Loading");
}

async function withPage(run: (page: import("playwright").Page) => Promise<void>): Promise<void> {
  await suite.withPage(
    {
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    },
    async ({ page }) => run(page),
  );
}

suite.define(() => {
  it("renders the Models initial load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "agents.list": {
            agents: [
              { id: "main", name: "Main" },
              { id: "reviewer", name: "Reviewer" },
            ],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": {
            config: {},
            hash: "settings-loading-models",
            issues: [],
            raw: "{}",
            valid: true,
          },
          "models.list": { models: [] },
          "models.authStatus": { providers: [], ts: Date.now() },
          "sessions.usage": { aggregates: { byProvider: [] } },
          "usage.status": { providers: [] },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-providers`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/model-providers",
        routeId: "model-providers",
      });
      await gateway.waitForRequest("models.authStatus");
      const authStatusRequestCount = (await gateway.getRequests("models.authStatus")).length;
      await gateway.deferNext("models.authStatus");
      await gateway.deferNext("models.authStatus");
      await gateway.deferNext("models.authStatus");
      const agentPicker = page.locator(".agent-scope-control openclaw-agent-select");
      await agentPicker.locator(".agent-select__trigger").click();
      await agentPicker.locator('wa-dropdown-item[aria-label="Reviewer"]').click();
      await expect
        .poll(async () => (await agentPicker.locator(".agent-select__label").textContent())?.trim())
        .toBe("Reviewer");
      await gateway.waitForRequest("models.authStatus", { after: authStatusRequestCount });
      await captureLoadingState(page.locator(".settings-page").first(), "models");
    });
  });

  it("renders the Channels pairing load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, {
        heldMethods: ["channels.pairing.list"],
        methodResponses: {
          "channels.status": {
            channelAccounts: {},
            channelDefaultAccountId: {},
            channelLabels: {},
            channelMeta: [],
            channelOrder: [],
            channels: {},
            ts: Date.now(),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/channels`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/channels",
        routeId: "channels",
      });
      await captureLoadingState(page.locator(".settings-page").first(), "channels-pairing");
    });
  });

  it("renders the Secrets initial load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, {
        featureMethods: ["secrets.store.list"],
        heldMethods: ["secrets.store.list"],
      });
      await page.goto(`${suite.server.baseUrl}settings/secrets`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/secrets",
        routeId: "secrets",
      });
      await captureLoadingState(page.locator(".settings-page").first(), "secrets");
    });
  });

  it("renders the Devices inventory load as one skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "device.pair.list": { paired: [], pending: [] },
          "node.list": { nodes: [] },
        },
        presenceUsers: [{ host: "Gateway", id: "gateway", mode: "gateway" }],
      });
      await page.goto(`${suite.server.baseUrl}settings/devices`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/devices",
        routeId: "devices",
      });
      await gateway.waitForRequest("device.pair.list");
      await gateway.deferNext("device.pair.list");
      await gateway.emitGatewayEvent("device.pair.requested", {});
      await captureLoadingState(
        page.locator(".settings-section", { hasText: "Devices" }).first(),
        "devices",
      );
    });
  });

  it("renders the MCP server load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, { heldMethods: ["config.get"] });
      await page.goto(`${suite.server.baseUrl}settings/mcp`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/mcp",
        routeId: "mcp",
      });
      await captureLoadingState(page.locator(".mcp-server-list"), "mcp");
    });
  });

  it("renders the Plugins catalog load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "plugins.list"],
        heldMethods: ["plugins.list"],
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins`);
      await gateway.waitForRequest("plugins.list");
      await captureLoadingState(page.locator(".plugins-panel"), "plugins-panel");
    });
  });

  it("renders the Plugins MCP config load as a skeleton", async () => {
    await withPage(async (page) => {
      await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "plugins.list"],
        heldMethods: ["config.get"],
        methodResponses: {
          "plugins.list": {
            diagnostics: [],
            mutationAllowed: true,
            plugins: [],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins`);
      const mcpSection = page.locator(".settings-section", { hasText: "MCP servers" }).first();
      await captureLoadingState(mcpSection, "plugins-mcp");
    });
  });

  it("renders the Profile identity load as a skeleton", async () => {
    await withPage(async (page) => {
      const profileId = "11111111-1111-4111-8111-111111111111";
      const gateway = await installMockGateway(page, {
        heldMethods: ["users.self"],
        presenceUsers: [
          {
            self: true,
            id: profileId,
            name: "Test Person",
            email: "test@example.com",
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}settings/profile`);
      await waitForControlUiRoute(page, { pathname: "/settings/profile", routeId: "profile" });
      await gateway.waitForRequest("users.self");
      await captureLoadingState(page.locator("#settings-profile-identity"), "profile-identity");
    });
  });

  it("renders both Agent Tools data loads as skeletons", async () => {
    await withPage(async (page) => {
      const config = {
        agents: { entries: { main: { default: true, tools: { profile: "full" } } } },
      };
      const gateway = await installMockGateway(page, {
        heldMethods: ["tools.catalog", "tools.effective"],
        methodResponses: {
          "agents.list": {
            agents: [{ id: "main", name: "Main agent" }],
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
          },
          "config.get": {
            config,
            sourceConfig: config,
            runtimeConfig: config,
            hash: "settings-loading-tools",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/agents/main/tools`);
      await gateway.waitForRequest("tools.catalog");
      await gateway.waitForRequest("tools.effective");
      const panel = page.locator("#agent-panel");
      await captureLoadingState(
        panel.locator(".settings-section", { hasText: "Available right now" }).first(),
        "agent-tools-available",
      );
      await captureLoadingState(
        captureBeforeProof
          ? panel.locator(".callout", { hasText: "Loading runtime tool catalog" }).first()
          : panel.locator(".settings-section", { hasText: "Tool catalog" }).first(),
        "agent-tools-catalog",
      );
    });
  });

  it("renders the Custodian history load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.changes.list"],
        heldMethods: ["openclaw.changes.list"],
      });
      await page.goto(`${suite.server.baseUrl}custodian`);
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      await page.getByRole("button", { name: "History", exact: true }).click();
      await gateway.waitForRequest("openclaw.changes.list");
      await captureLoadingState(page.locator(".custodian__history"), "custodian-history");
    });
  });

  it("uses a compact spinner when Custodian refreshes existing history", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "openclaw.changes.list"],
        methodResponses: {
          "openclaw.changes.list": {
            entries: [
              {
                at: Date.now() - 5_000,
                id: "system-agent-audit:3",
                kind: "operation",
                source: "system-agent",
                summary: "Set config gateway.port",
              },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}custodian`);
      await waitForControlUiRoute(page, { pathname: "/custodian", routeId: "custodian" });
      const historyToggle = page.getByRole("button", { name: "History", exact: true });
      await historyToggle.click();
      await gateway.waitForRequest("openclaw.changes.list");
      await page.locator(".custodian__change-card").waitFor();

      const requestCount = (await gateway.getRequests("openclaw.changes.list")).length;
      await gateway.deferNext("openclaw.changes.list");
      await historyToggle.click();
      await historyToggle.click();
      await gateway.waitForRequest("openclaw.changes.list", { after: requestCount });

      const history = page.locator(".custodian__history");
      const spinner = history.locator(".custodian__history-spinner");
      await spinner.waitFor({ state: "visible" });
      expect(await history.locator(".settings-loading-skeleton").count()).toBe(0);
      await captureScreenshot(history, "custodian-refresh");
    });
  });

  it("renders the Approvals history load as a skeleton", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "approval.history"],
        heldMethods: ["approval.history"],
        operatorScopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      });
      await page.goto(`${suite.server.baseUrl}settings/approvals`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/approvals",
        routeId: "approvals",
      });
      await gateway.waitForRequest("approval.history");
      await captureLoadingState(page.locator(".settings-page").first(), "approvals-history");
    });
  });

  it("renders the Channels config schema load as a skeleton", async () => {
    await withPage(async (page) => {
      const config = { channels: { whatsapp: { enabled: true } } };
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.schema"],
        methodResponses: {
          "channels.pairing.list": {
            accounts: [],
            requests: [],
            commandOwnerConfigured: true,
            limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
          },
          "channels.status": {
            ts: Date.now(),
            channelOrder: ["whatsapp"],
            channelLabels: { whatsapp: "WhatsApp" },
            channels: {
              whatsapp: {
                configured: true,
                linked: true,
                running: true,
                connected: true,
                reconnectAttempts: 0,
              },
            },
            channelAccounts: {},
            channelDefaultAccountId: {},
          },
          "config.get": {
            config,
            hash: "settings-loading-channel-schema",
            issues: [],
            raw: JSON.stringify(config),
            valid: true,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/channels`);
      await waitForControlUiRoute(page, { pathname: "/settings/channels", routeId: "channels" });
      await gateway.waitForRequest("config.schema");
      await page
        .locator("button.channels-item, button.channels-item__detail", { hasText: "WhatsApp" })
        .first()
        .click();
      await captureLoadingState(page.locator(".channels-detail"), "channels-schema");
    });
  });

  it("preserves the schema-driven Config spinner", async () => {
    await withPage(async (page) => {
      const gateway = await installMockGateway(page, {
        heldMethods: ["config.schema"],
        methodResponses: {
          "config.get": {
            config: {},
            hash: "settings-loading-config-schema",
            issues: [],
            raw: "{}",
            valid: true,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/infrastructure`);
      await waitForControlUiRoute(page, {
        pathname: "/settings/infrastructure",
        routeId: "infrastructure",
      });
      await gateway.waitForRequest("config.schema");
      const panel = page.locator("#config-section-panel");
      const spinner = panel.locator(".config-loading__spinner");
      await spinner.waitFor({ state: "visible" });
      expect(await spinner.isVisible()).toBe(true);
      expect(await panel.locator(".settings-loading-skeleton").count()).toBe(0);
      await captureScreenshot(panel, "config-schema");
    });
  });

  it("wraps row-shaped loading controls at the compact breakpoint", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 844, width: 390 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: ["secrets.store.list"],
          heldMethods: ["secrets.store.list"],
        });
        await page.goto(`${suite.server.baseUrl}settings/secrets`);
        const row = page.locator(".settings-loading-skeleton__row").first();
        const text = row.locator(".settings-row__text");
        const control = row.locator(".settings-row__control");
        await row.waitFor();
        const [textBox, controlBox] = await Promise.all([
          text.boundingBox(),
          control.boundingBox(),
        ]);
        expect(textBox).not.toBeNull();
        expect(controlBox).not.toBeNull();
        expect(controlBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height);
        await captureLoadingState(page.locator(".settings-page").first(), "secrets-mobile");
      },
    );
  });

  it("renders the lazy Settings sidebar as navigation skeletons", async () => {
    await withPage(async (page) => {
      let releaseSidebar: (() => void) | undefined;
      const sidebarRelease = new Promise<void>((resolve) => {
        releaseSidebar = resolve;
      });
      await page.route("**/src/components/settings-sidebar.ts*", async (route) => {
        await sidebarRelease;
        await route.continue();
      });
      await installMockGateway(page);
      try {
        await page.goto(`${suite.server.baseUrl}settings/appearance`);
        await captureLoadingState(page.locator(".settings-sidebar"), "settings-sidebar");
      } finally {
        releaseSidebar?.();
      }
    });
  });
});
