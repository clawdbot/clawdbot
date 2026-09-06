// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { describe } from "vitest";
import type { PluginsSearchResult } from "../../../../packages/gateway-protocol/src/schema/plugins.ts";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
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
} from "../../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
  finalDiscoveryPageItems,
  featuredResult,
  localOnlyDiscoveryPlugin,
  matrixDiscoveryPlugin,
  secondDiscoveryPageItems,
} from "../../test-helpers/plugins-e2e-fixtures.test-support.ts";
const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const updateScreenshots = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/plugins");
const desktopViewport = { height: 1000, width: 1440 };
const pluginMethods = [
  "plugins.list",
  "plugins.inspect",
  "plugins.search",
  "plugins.catalog.browse",
  "plugins.catalog.categories",
  "plugins.catalog.get",
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

const telegramPlugin = {
  id: "telegram",
  name: "Telegram",
  packageName: "@openclaw/telegram",
  description: "Chat with your agent from Telegram groups and direct messages.",
  version: "1.4.0",
  kind: ["channel"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  category: "channel",
  removable: false,
} satisfies PluginCatalogItem;

function installedInventoryPlugin(
  id: string,
  overrides: Partial<PluginCatalogItem> = {},
): PluginCatalogItem {
  return {
    id,
    name: id
      .split("-")
      .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
      .join(" "),
    description: `Operator-visible capability for ${id}.`,
    kind: ["productivity"],
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    category: "tool",
    removable: false,
    ...overrides,
  };
}

const installedPluginsItems = [
  installedInventoryPlugin("attention-b", {
    state: "error",
    error: "Manifest B failed",
    order: 20,
  }),
  installedInventoryPlugin("enabled-b", { enabled: true, state: "enabled", order: 20 }),
  installedInventoryPlugin("needs-setup", { state: "needs-setup", order: 5 }),
  ...Array.from({ length: 11 }, (_, index) =>
    installedInventoryPlugin(
      index === 0 ? "workboard" : `disabled-${String(index).padStart(2, "0")}`,
      {
        ...(index === 0
          ? {
              name: "Workboard",
              description: "Dashboard workboard for agent-owned issues and sessions.",
            }
          : {}),
        order: index,
      },
    ),
  ),
  installedInventoryPlugin("attention-a", {
    state: "error",
    error: "Manifest A failed",
    order: 10,
    category: "internal-category",
  }),
  installedInventoryPlugin("enabled-a", { enabled: true, state: "enabled", order: 10 }),
];

const installedPluginsInventory = inventory(installedPluginsItems);

const initialInventory = inventory([
  workboardDisabled,
  telegramPlugin,
  lobsterPlugin,
  remoteIconPlugin,
]);
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

const matrixDetail = {
  plugin: matrixDiscoveryPlugin,
  detail: {
    origin: "clawhub",
    packageName: "matrix",
    author: { handle: "openclaw", displayName: "OpenClaw" },
    topics: ["Matrix", "Messaging"],
    createdAt: 1_760_000_000_000,
    updatedAt: 1_780_000_000_000,
    readme: "# Matrix\n\nConnect OpenClaw to Matrix rooms and direct messages.",
    compatibility: {
      minGatewayVersion: ">=2026.5.1",
      pluginApiRange: ">=2026.5.1",
    },
    configuration: [
      {
        name: "homeserver",
        description: "Matrix homeserver URL",
        required: true,
        sensitive: false,
      },
      {
        name: "accessToken",
        description: "Matrix access token",
        required: true,
        sensitive: true,
      },
    ],
    mcpServers: [],
    skills: [{ name: "Matrix messaging", description: "Send and receive Matrix messages." }],
    versions: [
      {
        version: "2.1.0",
        createdAt: 1_780_000_000_000,
        changelog: "Current release",
        tags: ["latest"],
      },
      { version: "2.0.0", createdAt: 1_770_000_000_000, changelog: "Previous release", tags: [] },
    ],
    verification: {
      tier: "source-linked",
      summary: "Validated package structure and linked release source.",
      sourceRepo: "openclaw/openclaw",
      sourceCommit: "abc123",
      sourcePath: "extensions/matrix",
      scanStatus: "clean",
    },
    security: {
      status: "clean",
      verdict: "benign",
      summary: "Capabilities match the stated purpose.",
      guidance: "Review the access token before enabling.",
      checkedAt: 1_780_000_000_000,
    },
  },
} satisfies PluginDiscoveryDetailResult;

const matrixNeedsSetup = {
  id: "matrix",
  name: "Matrix",
  packageName: "matrix",
  description: "Connect OpenClaw to Matrix rooms and direct messages.",
  version: "2.1.0",
  kind: ["channel"],
  origin: "global",
  installed: true,
  enabled: false,
  state: "needs-setup",
  category: "channel",
  removable: true,
} satisfies PluginCatalogItem;

const matrixEnabled = {
  ...matrixNeedsSetup,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

const matrixConfigSchema = {
  generatedAt: "2026-09-03T00:00:00.000Z",
  schema: {
    type: "object",
    properties: {
      plugins: {
        type: "object",
        properties: {
          entries: {
            type: "object",
            properties: {
              matrix: {
                type: "object",
                properties: {
                  enabled: { type: "boolean", title: "Enabled" },
                  config: {
                    type: "object",
                    properties: {
                      homeserver: { type: "string", title: "Homeserver" },
                      accessToken: { type: "string", title: "Access token" },
                    },
                    required: ["homeserver", "accessToken"],
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  uiHints: {
    "plugins.entries.matrix.config.homeserver": { advanced: false },
    "plugins.entries.matrix.config.accessToken": { advanced: false, sensitive: true },
  },
  version: "e2e",
};

const localOnlyDetail = {
  plugin: localOnlyDiscoveryPlugin,
  detail: {
    origin: "local",
    packageName: "@openclaw/local-calendar",
    topics: [],
    configuration: [],
    mcpServers: [],
    skills: [{ name: "Calendar planning" }],
    versions: [],
  },
} satisfies PluginDiscoveryDetailResult;

const localCalendarDisabled = {
  id: "local-calendar",
  name: "Local Calendar",
  packageName: "@openclaw/local-calendar",
  description: "Coordinate work using the included calendar plugin.",
  version: "1.0.0",
  kind: ["productivity"],
  origin: "official",
  installed: true,
  enabled: false,
  state: "disabled",
  category: "tool",
  removable: false,
} satisfies PluginCatalogItem;

const localCalendarEnabled = {
  ...localCalendarDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

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
    "plugins.catalog.browse": {
      cases: [
        { match: { intent: "featured", pageSize: 9 }, response: featuredResult },
        {
          match: { intent: "all", cursor: "catalog-page-2", pageSize: 25 },
          response: {
            items: secondDiscoveryPageItems,
            nextCursor: "catalog-page-3",
          },
        },
        {
          match: { intent: "all", cursor: "catalog-page-3", pageSize: 25 },
          response: { items: finalDiscoveryPageItems },
        },
        {
          match: { intent: "official", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        {
          match: { intent: "all", category: "channels", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        {
          match: { intent: "all", query: "matrix", pageSize: 25 },
          response: { items: [matrixDiscoveryPlugin] },
        },
        { match: { intent: "all", pageSize: 25 }, response: discoveryResult },
      ],
    },
    "plugins.catalog.categories": discoveryCategories,
    "plugins.catalog.get": {
      cases: [
        { match: { id: matrixDiscoveryPlugin.id }, response: matrixDetail },
        { match: { id: localOnlyDiscoveryPlugin.id }, response: localOnlyDetail },
      ],
    },
    "plugins.install": {
      cases: [
        {
          match: {
            source: "clawhub",
            packageName: "calendar-plus",
            acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
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

export async function setupPluginsE2e(): Promise<void> {
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
}

export async function teardownPluginsE2e(): Promise<void> {
  await browser?.close();
  await server?.close();
}

export {
  captureScreenshot,
  desktopViewport,
  describeControlUiE2e,
  discoveryResult,
  initialInventory,
  installMockGateway,
  installedPluginsInventory,
  inventory,
  localCalendarDisabled,
  localCalendarEnabled,
  localOnlyDiscoveryPlugin,
  matrixConfigSchema,
  matrixDiscoveryPlugin,
  matrixEnabled,
  matrixNeedsSetup,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  readOnlyConnectResponse,
  server,
};
