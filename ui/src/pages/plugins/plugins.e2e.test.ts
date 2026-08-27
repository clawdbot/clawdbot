// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { PluginsSearchResult } from "../../../../packages/gateway-protocol/src/schema/plugins.ts";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginMutationResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/plugins");
const desktopViewport = { height: 1000, width: 1440 };
const mobileViewport = { height: 852, width: 393 };
const pluginMethods = [
  "plugins.list",
  "plugins.inspect",
  "plugins.search",
  "plugins.install",
  "plugins.setEnabled",
  "plugins.uninstall",
];

const workboardDisabled = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  version: "2026.7.9",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  featured: true,
  order: 10,
  category: "tool",
  removable: false,
} satisfies PluginCatalogItem;

const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const lobsterPlugin = {
  id: "lobster",
  name: "Lobster",
  description: "Run typed workflows with resumable approvals.",
  kind: ["plugin"],
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  featured: true,
  order: 50,
  install: { source: "clawhub", packageName: "@openclaw/lobster" },
} satisfies PluginCatalogItem;

const installedLobsterPlugin = {
  ...lobsterPlugin,
  packageName: "@openclaw/lobster",
  version: "2026.8.10",
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  removable: true,
} satisfies PluginCatalogItem;

const remoteIconPlugin = {
  id: "remote-icon",
  name: "FireCrawl",
  description: "Web extraction and crawling.",
  kind: ["plugin"],
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
  featured: true,
  order: 60,
  hasIcon: true,
  install: { source: "clawhub", packageName: "@openclaw/firecrawl" },
} satisfies PluginCatalogItem;

const calendarPlugin = {
  id: "calendar-plus",
  name: "Calendar Plus",
  packageName: "calendar-plus",
  description: "Plan and coordinate work from a shared calendar.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  category: "tool",
  removable: true,
} satisfies PluginCatalogItem;

const initialInventory = inventory([workboardDisabled, lobsterPlugin, remoteIconPlugin]);
const installedInventory = inventory([
  workboardDisabled,
  lobsterPlugin,
  remoteIconPlugin,
  calendarPlugin,
]);
const finalInventory = inventory([
  workboardEnabled,
  lobsterPlugin,
  remoteIconPlugin,
  calendarPlugin,
]);
const uninstalledInventory = inventory([workboardEnabled, lobsterPlugin, remoteIconPlugin]);

const calendarSearchResponse = {
  results: [
    {
      score: 0.98,
      package: {
        name: "calendar-plus",
        displayName: "Calendar Plus",
        family: "code-plugin",
        channel: "community",
        isOfficial: false,
        summary: "Plan and coordinate work from a shared calendar.",
        latestVersion: "1.2.3",
        downloads: 1420,
        verificationTier: "source-linked",
      },
    },
  ],
} satisfies PluginsSearchResult;

const lobsterSearchResponse = {
  results: [
    {
      score: 1,
      package: {
        name: "@openclaw/lobster",
        displayName: "Lobster",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        runtimeId: "lobster",
      },
    },
  ],
} satisfies PluginsSearchResult;

const uninstallResult = {
  ok: true,
  pluginId: "calendar-plus",
  restartRequired: true,
  removed: ["config entry", "install record", "directory"],
};

const installResult = {
  ok: true,
  plugin: calendarPlugin,
  restartRequired: true,
} satisfies PluginMutationResult;

const installPolicyWarning = {
  installPolicyCode: "install_policy_warning_acknowledgement_required",
  targetName: "@openclaw/lobster",
  targetType: "plugin",
  requestMode: "install",
  reason: "ClawScan found issues to review.",
  findings: [
    {
      ruleId: "semgrep-finding",
      severity: "warn",
      message: "Semgrep found a risky command.",
      file: "index.ts",
      line: 12,
    },
  ],
};

const changedInstallPolicyWarning = {
  ...installPolicyWarning,
  reason: "ClawScan returned a changed warning after the fresh check.",
  findings: [
    {
      ruleId: "dependency-finding",
      severity: "critical",
      message: "The freshly checked warning changed and requires review.",
      file: "package-lock.json",
      line: 24,
    },
  ],
};

const enableWorkboardResult = {
  ok: true,
  plugin: workboardEnabled,
  restartRequired: false,
} satisfies PluginMutationResult;

const workboardInspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboardDisabled.id,
    name: workboardDisabled.name,
    origin: workboardDisabled.origin,
    installed: true,
    enabled: false,
  },
  source: { kind: "npm", packageName: workboardDisabled.packageName },
  declared: {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: true },
      allowConversationAccess: { effective: true },
    },
  },
} satisfies PluginsInspectResult;

const lobsterInspection = {
  ...workboardInspection,
  reviewToken: "b".repeat(64),
  plugin: {
    id: lobsterPlugin.id,
    name: lobsterPlugin.name,
    origin: lobsterPlugin.origin,
    installed: false,
    enabled: false,
  },
  source: { kind: "npm", packageName: "@openclaw/lobster" },
} satisfies PluginsInspectResult;

const calendarInspection = {
  ...workboardInspection,
  reviewToken: "c".repeat(64),
  plugin: { ...calendarPlugin, installed: false, enabled: false },
  source: { kind: "clawhub", packageName: "calendar-plus" },
  declared: { ...workboardInspection.declared, tools: ["calendar_create"] },
} satisfies PluginsInspectResult;

let browser: Browser;
let server: ControlUiE2eServer;

function inventory(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

function configSnapshot(isWorkboardEnabled: boolean) {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: isWorkboardEnabled },
      },
    },
  };
  return {
    config,
    hash: isWorkboardEnabled ? "plugins-config-enabled" : "plugins-config-disabled",
    issues: [],
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
    valid: true,
  };
}

function readOnlyConnectResponse() {
  return {
    auth: {
      deviceToken: "plugins-read-only-device-token",
      role: "operator",
      scopes: ["operator.read"],
    },
    features: { events: [], methods: pluginMethods },
    controlUiTabs: [],
    protocol: PROTOCOL_VERSION,
    server: { connId: "plugins-read-only", version: "e2e" },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "main",
        scope: "agent",
      },
    },
    type: "hello-ok",
  };
}

function enabledWorkboardConnectResponse() {
  return {
    ...readOnlyConnectResponse(),
    auth: {
      deviceToken: "plugins-workboard-device-token",
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    },
    controlUiTabs: [
      {
        group: "control",
        icon: "kanban",
        id: "workboard",
        label: "Workboard",
        placement: "route:workboard",
        pluginId: "workboard",
      },
    ],
  };
}

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

async function waitForNextRequest(
  gateway: MockGatewayControls,
  method: string,
  previousCount: number,
): Promise<MockGatewayRequest> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length > previousCount) {
      const request = requests.at(-1);
      if (request) {
        return request;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for the next ${method} request`);
}

async function clickRowAction(page: Page, rowSelector: string, buttonName: string): Promise<void> {
  await page.locator(rowSelector).getByRole("button", { name: buttonName, exact: true }).click();
}

async function captureScreenshot(page: Page, name: string): Promise<void> {
  if (!updateScreenshots) {
    return;
  }
  await mkdir(artifactDir, { recursive: true });
  await page.locator(".content").screenshot({
    animations: "disabled",
    caret: "hide",
    path: path.join(artifactDir, name),
  });
}

async function newContext(viewport = desktopViewport): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
}

function pluginMethodResponses() {
  return {
    "config.get": configSnapshot(false),
    "plugins.list": initialInventory,
    "plugins.inspect": {
      cases: [
        { match: { pluginId: "workboard" }, response: workboardInspection },
        { match: { pluginId: "lobster" }, response: lobsterInspection },
        { match: { pluginId: "calendar-plus" }, response: calendarInspection },
      ],
    },
    "plugins.search": {
      cases: [
        {
          match: { query: "calendar", limit: 20 },
          response: calendarSearchResponse,
        },
      ],
    },
    "plugins.install": {
      cases: [
        {
          match: {
            source: "clawhub",
            packageName: "calendar-plus",
            version: "1.2.3",
            acknowledgeClawHubRisk: true,
          },
          response: installResult,
        },
      ],
    },
    "plugins.setEnabled": {
      cases: [
        {
          match: { pluginId: "workboard", enabled: true },
          response: enableWorkboardResult,
        },
      ],
    },
    "plugins.uninstall": {
      cases: [
        {
          match: { pluginId: "calendar-plus" },
          response: uninstallResult,
        },
      ],
    },
  };
}

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    if (updateScreenshots) {
      await rm(artifactDir, { force: true, recursive: true });
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["installed", "discover"] as const)(
    "finds an existing plugin by scoped package identity in the %s catalog",
    async (tab) => {
      const context = await newContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: pluginMethods,
        methodResponses: {
          ...pluginMethodResponses(),
          "plugins.search": { results: [] },
        },
      });

      try {
        await page.goto(`${server.baseUrl}settings/plugins`);
        const workboardCard = page.locator('[data-plugin-id="workboard"]');
        await workboardCard.waitFor({ state: "visible" });

        if (tab === "discover") {
          await page.getByRole("tab", { name: /^Discover/u }).click();
          await workboardCard.waitFor({ state: "visible" });
        }

        await page.getByRole("searchbox", { name: "Search plugins" }).fill("@openclaw/workboard");
        await workboardCard.waitFor({ state: "visible", timeout: 5_000 });
        await captureScreenshot(page, `08-scoped-package-${tab}.png`);

        if (tab === "discover") {
          const searchRequest = await gateway.waitForRequest("plugins.search");
          expect(requestParams(searchRequest)).toEqual({
            query: "@openclaw/workboard",
            limit: 20,
          });
        }
      } finally {
        await context.close();
      }
    },
  );

  it("browses the catalog, installs from ClawHub, enables Workboard, and refreshes authoritative state", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await page.addInitScript(
      ({ gatewayUrl }) => {
        window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
      },
      { gatewayUrl: server.baseUrl.replace(/^http/u, "ws") },
    );
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    let pluginIconAuth = "";
    await page.route("**/__openclaw__/plugin-icon/remote-icon", async (route) => {
      pluginIconAuth = route.request().headers().authorization ?? "";
      await route.fulfill({
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#f97316" d="M4 3h16v18H4z"/></svg>`,
        contentType: "image/svg+xml",
        headers: {
          "content-disposition": 'attachment; filename="plugin-icon.svg"',
          "content-security-policy": "default-src 'none'; sandbox",
        },
        status: 200,
      });
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/plugins`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-plugin-id="workboard"]').waitFor({ state: "visible" });
      await gateway.waitForRequest("config.get");

      const workboardCard = page.locator('[data-plugin-id="workboard"]');
      await page.getByRole("heading", { name: /^Tools/u }).waitFor();
      await page.getByRole("heading", { name: /^MCP servers/u }).waitFor();
      await workboardCard.getByRole("button", { name: "Enable", exact: true }).waitFor();
      await captureScreenshot(page, "01-installed-desktop.png");

      // The row's primary action is a real named button, so keyboard users can inspect plugins.
      const detailsButton = workboardCard.getByRole("button", { name: "Workboard", exact: true });
      await detailsButton.focus();
      await page.keyboard.press("Enter");
      const detail = page.locator(".plugins-detail");
      await detail.waitFor({ state: "visible" });
      expect(await detail.textContent()).toContain("Workboard");
      await captureScreenshot(page, "02-detail-desktop.png");
      await detail.getByRole("button", { name: "Close" }).click();
      await detail.waitFor({ state: "detached" });

      await page.getByRole("tab", { name: /^Discover/u }).click();
      await page.getByRole("heading", { name: /^Featured/u }).waitFor();
      await page.getByRole("heading", { name: /^Connect your world/u }).waitFor();
      const lobsterCard = page.locator('[data-plugin-id="lobster"]');
      await lobsterCard.getByRole("button", { name: "Install Lobster" }).waitFor();
      // Bundled art renders instead of monogram fallbacks for curated plugins.
      await lobsterCard.locator(".plugins-tile img").waitFor({ state: "attached" });
      const remoteIconCard = page.locator('[data-plugin-id="remote-icon"]');
      const remoteIcon = remoteIconCard.locator(".plugins-tile img.plugins-icon");
      await remoteIcon.waitFor({ state: "visible" });
      expect(pluginIconAuth).toBe("Bearer e2e-device-token");
      await expect
        .poll(
          async () =>
            await remoteIcon.evaluate(async (image: HTMLImageElement) => {
              const iconResponse = await fetch(image.src);
              return (await iconResponse.blob()).type;
            }),
        )
        .toBe("image/png");
      await page
        .locator('[data-connector-id="github"]')
        .getByRole("button", { name: "Add", exact: true })
        .waitFor();
      await captureScreenshot(page, "03-discover-desktop.png");

      // Search is unified: results append below the discover shelves.
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
      const searchRequest = await gateway.waitForRequest("plugins.search");
      expect(requestParams(searchRequest)).toEqual({ query: "calendar", limit: 20 });
      await page.getByRole("heading", { name: /^From ClawHub/u }).waitFor();
      const searchRow = page.locator('[data-package-name="calendar-plus"]');
      await searchRow.waitFor({ state: "visible" });
      expect(await searchRow.textContent()).toContain("Calendar Plus");
      expect(await searchRow.textContent()).toContain("Verified source");
      expect(await searchRow.textContent()).toContain("1.4K");
      await page.getByRole("searchbox", { name: "Search plugins" }).blur();
      await captureScreenshot(page, "04-search-desktop.png");

      await gateway.deferNext("plugins.install");
      await searchRow.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      const firstInstallRequest = await gateway.waitForRequest("plugins.install");
      expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
      expect(requestParams(firstInstallRequest)).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "ClawHub requires acknowledgement before installing this release.",
        details: {
          clawhubTrustCode: "clawhub_risk_acknowledgement_required",
          version: "1.2.3",
          warning: "REVIEW REQUIRED - ClawHub found behavior that needs operator review.",
        },
      });

      const acknowledgeButton = searchRow.getByRole("button", {
        name: "Acknowledge risk and install",
      });
      await acknowledgeButton.waitFor({ state: "visible" });
      expect(await searchRow.getByRole("alert").textContent()).toContain("REVIEW REQUIRED");

      const listCountBeforeInstall = (await gateway.getRequests("plugins.list")).length;
      const configCountBeforeInstall = (await gateway.getRequests("config.get")).length;
      const installCountBeforeRetry = (await gateway.getRequests("plugins.install")).length;
      await gateway.deferNext("plugins.list");
      await gateway.deferNext("config.get");
      await gateway.deferNext("plugins.install");
      await acknowledgeButton.click();

      const retryInstallRequest = await waitForNextRequest(
        gateway,
        "plugins.install",
        installCountBeforeRetry,
      );
      expect(requestParams(retryInstallRequest)).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
        version: "1.2.3",
        acknowledgeClawHubRisk: true,
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "Capability consent required",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
        }),
      });
      const consent = page.locator('[data-plugin-consent="install"]');
      await consent.getByText("calendar_create", { exact: true }).waitFor();
      await captureScreenshot(page, "artifact-consent-desktop.png");
      await gateway.setMethodResponse("plugins.install", installResult);
      const installCountBeforeConsent = (await gateway.getRequests("plugins.install")).length;
      const confirm = consent.getByRole("button", { name: "Install Calendar Plus", exact: true });
      await expect.poll(() => confirm.isEnabled()).toBe(true);
      await confirm.click();
      expect(
        requestParams(
          await waitForNextRequest(gateway, "plugins.install", installCountBeforeConsent),
        ),
      ).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
        version: "1.2.3",
        acknowledgeClawHubRisk: true,
        acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
      });
      // The mutation boundary refreshes config before the page refreshes the
      // plugin catalog; release the deferred requests in that contract order.
      const postInstallConfigRequest = await waitForNextRequest(
        gateway,
        "config.get",
        configCountBeforeInstall,
      );
      expect(requestParams(postInstallConfigRequest)).toEqual({});
      await gateway.resolveDeferred("config.get", configSnapshot(false));
      const postInstallListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeInstall,
      );
      expect(requestParams(postInstallListRequest)).toEqual({});
      await expect.poll(() => searchRow.getAttribute("aria-busy")).toBe("true");
      expect(await searchRow.getByRole("status").textContent()).toContain(
        "A Gateway restart is required",
      );
      await gateway.resolveDeferred("plugins.list", installedInventory);
      await expect.poll(() => searchRow.getAttribute("aria-busy")).toBe("false");
      // Installed search results swap Install for the enable/disable toggle.
      await page
        .locator('[data-package-name="calendar-plus"][data-plugin-status="enabled"]')
        .waitFor({ state: "attached" });

      await page.getByRole("tab", { name: /^Installed/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("");
      await workboardCard.waitFor({ state: "visible" });
      const listCountBeforeEnable = (await gateway.getRequests("plugins.list")).length;
      const configCountBeforeEnable = (await gateway.getRequests("config.get")).length;
      const connectCountBeforeEnable = (await gateway.getRequests("connect")).length;
      const enableCountBefore = (await gateway.getRequests("plugins.setEnabled")).length;
      await gateway.deferNext("plugins.list");
      await gateway.deferNext("config.get");
      await clickRowAction(page, '[data-plugin-id="workboard"]', "Enable");

      const enableRequest = await waitForNextRequest(
        gateway,
        "plugins.setEnabled",
        enableCountBefore,
      );
      expect(requestParams(enableRequest)).toEqual({ pluginId: "workboard", enabled: true });
      const postEnableConfigRequest = await waitForNextRequest(
        gateway,
        "config.get",
        configCountBeforeEnable,
      );
      expect(requestParams(postEnableConfigRequest)).toEqual({});
      await gateway.setMethodResponse("plugins.list", finalInventory);
      await gateway.setMethodResponse("config.get", configSnapshot(true));
      await gateway.setMethodResponse("connect", enabledWorkboardConnectResponse());
      await gateway.resolveDeferred("config.get", configSnapshot(true));
      const postEnableListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeEnable,
      );
      expect(requestParams(postEnableListRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", finalInventory);
      await waitForNextRequest(gateway, "connect", connectCountBeforeEnable);
      await expect.poll(() => workboardCard.getAttribute("aria-busy")).toBe("false");

      await page
        .locator('[data-plugin-id="workboard"][data-plugin-status="enabled"]')
        .waitFor({ state: "attached" });
      const calendarRow = page.locator('[data-plugin-id="calendar-plus"]');
      await calendarRow.waitFor({ state: "visible" });
      await captureScreenshot(page, "05-enabled-installed-desktop.png");

      // Removable installs expose a confirm-guarded uninstall behind the trash button.
      await clickRowAction(page, '[data-plugin-id="calendar-plus"]', "Remove Calendar Plus");
      const uninstallCountBefore = (await gateway.getRequests("plugins.uninstall")).length;
      const listCountBeforeRemove = (await gateway.getRequests("plugins.list")).length;
      const configCountBeforeRemove = (await gateway.getRequests("config.get")).length;
      await gateway.deferNext("plugins.list");
      // Keep the authoritative config refresh on the workboard-enabled snapshot
      // so the conditional sidebar route assertion below stays meaningful.
      await gateway.deferNext("config.get");
      await calendarRow.getByRole("button", { name: "Remove", exact: true }).click();
      const uninstallRequest = await waitForNextRequest(
        gateway,
        "plugins.uninstall",
        uninstallCountBefore,
      );
      expect(requestParams(uninstallRequest)).toEqual({ pluginId: "calendar-plus" });
      const postUninstallConfigRequest = await waitForNextRequest(
        gateway,
        "config.get",
        configCountBeforeRemove,
      );
      expect(requestParams(postUninstallConfigRequest)).toEqual({});
      await gateway.resolveDeferred("config.get", configSnapshot(true));
      const postUninstallListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeRemove,
      );
      expect(requestParams(postUninstallListRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", uninstalledInventory);
      await calendarRow.waitFor({ state: "detached" });
      expect(await page.locator(".plugins-page-notice").textContent()).toContain(
        "Removed calendar-plus",
      );

      await gateway.setMethodResponse("plugins.list", uninstalledInventory);
      await page.getByRole("tab", { name: /^Discover/u }).click();
      const searchCountBeforeReinstall = (await gateway.getRequests("plugins.search")).length;
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
      await waitForNextRequest(gateway, "plugins.search", searchCountBeforeReinstall);
      const reinstallRow = page.locator(
        '[data-package-name="calendar-plus"][data-plugin-status="not-installed"]',
      );
      await reinstallRow.waitFor({ state: "visible" });
      await gateway.setMethodResponse("plugins.install", installResult);
      await gateway.setMethodResponse("plugins.list", finalInventory);
      const installCountBeforeReinstall = (await gateway.getRequests("plugins.install")).length;
      await reinstallRow
        .getByRole("button", { name: "Install Calendar Plus", exact: true })
        .click();
      const reinstallRequest = await waitForNextRequest(
        gateway,
        "plugins.install",
        installCountBeforeReinstall,
      );
      expect(requestParams(reinstallRequest)).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      const reinstalledRow = page.locator(
        '[data-package-name="calendar-plus"][data-plugin-status="enabled"]',
      );
      await reinstalledRow.waitFor({ state: "attached" });
      await captureScreenshot(page, "11-reinstalled-feedback-desktop.png");
      expect(await page.locator(".plugins-page-notice").count()).toBe(0);
      expect(await reinstalledRow.getByRole("status").textContent()).toContain(
        "Installed Calendar Plus",
      );

      await page.getByRole("tab", { name: /^Installed/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("");
      await page.setViewportSize(mobileViewport);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await workboardCard.waitFor({ state: "visible" });
      await captureScreenshot(page, "06-installed-mobile.png");

      await page.setViewportSize(desktopViewport);
      const settingsSidebar = page.locator(".settings-sidebar");
      if (await settingsSidebar.isVisible()) {
        await settingsSidebar.getByRole("button", { name: "Back to app" }).click();
      }
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.waitFor({ state: "visible" });
      const workboardSidebarItem = sidebar.locator(
        '.sidebar-zone-entry[data-sidebar-entry="plugin:workboard/workboard"] > .nav-item',
      );
      await workboardSidebarItem.waitFor({ state: "visible" });
      expect(await workboardSidebarItem.getAttribute("href")).toBe("/workboard");
      if (updateScreenshots) {
        await mkdir(artifactDir, { recursive: true });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, "07-workboard-sidebar.png"),
        });
      }
    } finally {
      await context.close();
    }
  });

  it("reviews an install policy warning before sending an acknowledged retry", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.search": lobsterSearchResponse,
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      await page.getByRole("tab", { name: /^Discover/u }).click();
      const row = page.locator('[data-plugin-id="lobster"]');
      await row.waitFor({ state: "visible" });

      await gateway.deferNext("plugins.install");
      await row.getByRole("button", { name: "Install Lobster", exact: true }).click();
      expect(requestParams(await gateway.waitForRequest("plugins.install"))).toEqual({
        source: "clawhub",
        packageName: "@openclaw/lobster",
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "raw terminal install-policy output",
        details: installPolicyWarning,
      });

      const review = row.getByRole("alert");
      await review.waitFor({ state: "visible" });
      expect(await review.textContent()).toContain("Security review needed");
      await review
        .getByText("ClawScan found issues to review.", { exact: true })
        .waitFor({ state: "visible" });
      expect(await review.textContent()).toContain("Policy warnings: 1");
      expect(await review.textContent()).toContain("Not installed");
      expect(await review.textContent()).toContain(
        "Install anyway approves every install-policy warning encountered during this install",
      );
      expect(await review.textContent()).toContain("Warning");
      expect(await review.textContent()).toContain("Semgrep found a risky command.");
      expect(await review.textContent()).not.toContain("raw terminal install-policy output");
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("lobster");
      await gateway.waitForRequest("plugins.search");
      const searchRow = page.locator('[data-package-name="@openclaw/lobster"]');
      const searchReview = searchRow.getByRole("alert");
      await searchReview.waitFor({ state: "visible" });
      expect(
        await searchRow.getByRole("button", { name: "Install Lobster", exact: true }).count(),
      ).toBe(0);
      await captureScreenshot(page, "09-policy-review-desktop.png");

      await page.setViewportSize(mobileViewport);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      await review.waitFor({ state: "visible" });
      await captureScreenshot(page, "09-policy-review-mobile.png");

      const installCountBeforeCancel = (await gateway.getRequests("plugins.install")).length;
      await searchReview.getByRole("button", { name: "Cancel", exact: true }).click();
      await review.waitFor({ state: "detached" });
      await searchReview.waitFor({ state: "detached" });
      expect((await gateway.getRequests("plugins.install")).length).toBe(installCountBeforeCancel);
      await page.setViewportSize(desktopViewport);

      const installCountBeforeSecondAttempt = (await gateway.getRequests("plugins.install")).length;
      await gateway.deferNext("plugins.install");
      await row.getByRole("button", { name: "Install Lobster", exact: true }).click();
      await waitForNextRequest(gateway, "plugins.install", installCountBeforeSecondAttempt);
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "raw terminal install-policy output",
        details: installPolicyWarning,
      });
      await review.waitFor({ state: "visible" });

      const installCountBeforeRetry = (await gateway.getRequests("plugins.install")).length;
      await gateway.deferNext("plugins.install");
      await searchReview.getByRole("button", { name: "Install anyway", exact: true }).click();
      const retry = await waitForNextRequest(gateway, "plugins.install", installCountBeforeRetry);
      expect(requestParams(retry)).toEqual({
        source: "clawhub",
        packageName: "@openclaw/lobster",
        acknowledgeInstallPolicyWarning: true,
      });
      const pendingRetry = review.getByRole("button", { name: "Installing…", exact: true });
      await pendingRetry.waitFor({ state: "visible" });
      expect(await pendingRetry.isDisabled()).toBe(true);
      expect(await review.textContent()).toContain("Semgrep found a risky command.");
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "raw dependency policy output",
        details: changedInstallPolicyWarning,
      });

      await review.waitFor({ state: "visible" });
      expect(await review.textContent()).toContain("Critical");
      expect(await review.textContent()).toContain(
        "The freshly checked warning changed and requires review.",
      );
      expect(await review.textContent()).not.toContain("raw dependency policy output");
      await captureScreenshot(page, "10-dependency-policy-review-desktop.png");

      const installCountBeforeSecondRetry = (await gateway.getRequests("plugins.install")).length;
      await gateway.deferNext("plugins.install");
      await review.getByRole("button", { name: "Install anyway", exact: true }).click();
      const secondRetry = await waitForNextRequest(
        gateway,
        "plugins.install",
        installCountBeforeSecondRetry,
      );
      expect(requestParams(secondRetry)).toEqual({
        source: "clawhub",
        packageName: "@openclaw/lobster",
        acknowledgeInstallPolicyWarning: true,
      });

      await gateway.setMethodResponse(
        "plugins.list",
        inventory([workboardDisabled, installedLobsterPlugin, remoteIconPlugin]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installedLobsterPlugin,
        restartRequired: true,
      } satisfies PluginMutationResult);
      await page
        .locator('[data-plugin-id="lobster"][data-plugin-status="enabled"]')
        .waitFor({ state: "visible" });
      await review.waitFor({ state: "detached" });
      await searchReview.waitFor({ state: "detached" });
      expect(await page.getByRole("button", { name: "Install anyway", exact: true }).count()).toBe(
        0,
      );
    } finally {
      await context.close();
    }
  });

  it("keeps plugin mutations unavailable to read-only operators while browse and search work", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      const workboardCard = page.locator('[data-plugin-id="workboard"]');
      await workboardCard.waitFor({ state: "visible" });
      expect(await page.getByRole("note").textContent()).toContain("operator.admin");
      expect(
        await workboardCard.getByRole("button", { name: "Enable", exact: true }).isDisabled(),
      ).toBe(true);

      await page.getByRole("tab", { name: /^Discover/u }).click();
      await page.getByRole("searchbox", { name: "Search plugins" }).fill("calendar");
      const searchRequest = await gateway.waitForRequest("plugins.search");
      expect(requestParams(searchRequest)).toEqual({ query: "calendar", limit: 20 });
      const installButton = page
        .locator('[data-package-name="calendar-plus"]')
        .getByRole("button", { name: "Install Calendar Plus", exact: true });
      await installButton.waitFor({ state: "visible" });
      expect(await installButton.isDisabled()).toBe(true);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
    } finally {
      await context.close();
    }
  });

  it("shows plugin list failures and retries the catalog request", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}settings/plugins`);
      await page.locator('[data-plugin-id="workboard"]').waitFor({ state: "visible" });
      const listCountBeforeFailure = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const failedListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeFailure,
      );
      expect(requestParams(failedListRequest)).toEqual({});
      await gateway.rejectDeferred("plugins.list", {
        code: "UNAVAILABLE",
        message: "Plugin inventory unavailable",
        retryable: true,
      });

      const error = page.locator(".plugins-page-error");
      await error.waitFor({ state: "visible" });
      expect(await error.textContent()).toContain("Plugin inventory unavailable");
      const listCountBeforeRetry = (await gateway.getRequests("plugins.list")).length;
      await gateway.deferNext("plugins.list");
      await error.getByRole("button", { name: "Try again" }).click();
      const retryListRequest = await waitForNextRequest(
        gateway,
        "plugins.list",
        listCountBeforeRetry,
      );
      expect(requestParams(retryListRequest)).toEqual({});
      await gateway.resolveDeferred("plugins.list", finalInventory);
      await error.waitFor({ state: "detached" });
      await page
        .locator('[data-plugin-id="workboard"][data-plugin-status="enabled"]')
        .waitFor({ state: "attached" });
    } finally {
      await context.close();
    }
  });
});
