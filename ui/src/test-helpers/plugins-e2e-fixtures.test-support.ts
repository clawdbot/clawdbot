import type { PluginsSearchResult } from "../../../packages/gateway-protocol/src/schema/plugins.ts";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
  PluginListResult,
  PluginMutationResult,
  PluginsInspectResult,
} from "../lib/plugins/index.ts";

function inventory(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

export const workboardDisabled = {
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

export const workboardEnabled = {
  ...workboardDisabled,
  enabled: true,
  state: "enabled",
} satisfies PluginCatalogItem;

export const lobsterPlugin = {
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

export const remoteIconPlugin = {
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

export const calendarPlugin = {
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

export const telegramPlugin = {
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

export const installedPluginsInventory = inventory([
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
]);

export const initialInventory = inventory([
  workboardDisabled,
  telegramPlugin,
  lobsterPlugin,
  remoteIconPlugin,
]);

export const uninstallResult = {
  ok: true,
  pluginId: "calendar-plus",
  restartRequired: true,
  removed: ["config entry", "install record", "directory"],
};

export const installResult = {
  ok: true,
  plugin: calendarPlugin,
  restartRequired: true,
} satisfies PluginMutationResult;

export const enableWorkboardResult = {
  ok: true,
  plugin: workboardEnabled,
  restartRequired: false,
} satisfies PluginMutationResult;

export const workboardInspection = {
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

export const lobsterInspection = {
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

export const calendarInspection = {
  ...workboardInspection,
  reviewToken: "c".repeat(64),
  plugin: { ...calendarPlugin, installed: false, enabled: false },
  source: { kind: "clawhub", packageName: "calendar-plus" },
  declared: { ...workboardInspection.declared, tools: ["calendar_create"] },
} satisfies PluginsInspectResult;

const memoryDiscoveryPlugin = {
  id: "ch_bWVtb3J5LXBsdXM",
  catalog: {
    name: "Memory Plus",
    summary: "Long-term memory for people and projects.",
    family: "code-plugin",
    author: "alice",
    official: false,
    categories: ["memory"],
    downloads: 1240,
  },
  local: {
    present: true,
    installed: true,
    enabled: false,
    state: "disabled",
    pluginId: "memory-plus",
    action: "manage",
  },
} satisfies PluginDiscoveryEntry;

export const matrixDiscoveryPlugin = {
  ...memoryDiscoveryPlugin,
  id: "ch_bWF0cml4",
  catalog: {
    ...memoryDiscoveryPlugin.catalog,
    name: "Matrix",
    summary: "Connect agents to Matrix rooms.",
    author: "openclaw",
    categories: ["channels"],
    downloads: 52_201,
    icon: "message-circle",
    official: true,
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

const telegramDiscoveryPlugin = {
  ...matrixDiscoveryPlugin,
  id: "ch_QG9wZW5jbGF3L3RlbGVncmFt",
  catalog: {
    ...matrixDiscoveryPlugin.catalog,
    name: "Telegram",
    summary: "Chat with your agent from Telegram groups and direct messages.",
    author: "openclaw",
    downloads: 12_847,
  },
  local: {
    present: true,
    installed: true,
    enabled: false,
    state: "disabled",
    pluginId: "telegram",
    action: "manage",
  },
} satisfies PluginDiscoveryEntry;

export const localOnlyDiscoveryPlugin = {
  id: "local_QG9wZW5jbGF3L2xvY2FsLWNhbGVuZGFy",
  catalog: {
    name: "Local Calendar",
    summary: "Coordinate work using the included calendar plugin.",
    official: false,
    categories: ["tools"],
    latestVersion: "1.0.0",
    publishedToClawHub: false,
  },
  local: {
    present: true,
    installed: false,
    enabled: false,
    state: "not-installed",
    pluginId: "local-calendar",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

function availableDiscoveryPlugin(index: number, prefix: string): PluginDiscoveryEntry {
  return {
    ...matrixDiscoveryPlugin,
    id: `ch_${prefix.toLowerCase().replaceAll(" ", "-")}_${index}`,
    catalog: {
      ...matrixDiscoveryPlugin.catalog,
      name: `${prefix} ${String(index).padStart(2, "0")}`,
      summary: `Catalog fixture ${prefix.toLowerCase()} ${index}.`,
      author: "publisher",
      official: false,
      downloads: 1_000 + index,
    },
  };
}

export const secondDiscoveryPageItems = Array.from({ length: 25 }, (_, index) =>
  availableDiscoveryPlugin(index, "Second page"),
);

export const finalDiscoveryPageItems = [
  {
    ...matrixDiscoveryPlugin,
    id: "ch_c2xhY2s",
    catalog: { ...matrixDiscoveryPlugin.catalog, name: "Slack" },
  },
  availableDiscoveryPlugin(0, "Final page"),
] satisfies PluginDiscoveryEntry[];

export const discoveryResult = {
  items: [
    localOnlyDiscoveryPlugin,
    memoryDiscoveryPlugin,
    matrixDiscoveryPlugin,
    telegramDiscoveryPlugin,
    ...Array.from({ length: 22 }, (_, index) => availableDiscoveryPlugin(index, "First page")),
  ],
  nextCursor: "catalog-page-2",
} satisfies PluginDiscoveryResult;

export const featuredResult = {
  items: [
    memoryDiscoveryPlugin,
    matrixDiscoveryPlugin,
    {
      ...memoryDiscoveryPlugin,
      id: "ch_bG9uZy1jb250ZXh0",
      catalog: {
        ...memoryDiscoveryPlugin.catalog,
        name: "Long Context",
        summary: "Keep long-running work focused.",
        categories: ["context"],
        icon: "book-open",
      },
      local: {
        present: false,
        installed: false,
        enabled: false,
        state: "not-installed",
        action: "install",
      },
    },
    ...Array.from({ length: 6 }, (_, index) => availableDiscoveryPlugin(index, "Featured")),
    {
      ...memoryDiscoveryPlugin,
      id: "ch_ZW5hYmxlZA",
      catalog: { ...memoryDiscoveryPlugin.catalog, name: "Already Enabled" },
      local: {
        present: true,
        installed: true,
        enabled: true,
        state: "enabled",
        pluginId: "already-enabled",
        action: "manage",
      },
    },
  ],
} satisfies PluginDiscoveryResult;

export const discoveryCategories = {
  categories: [
    ["channels", "Channels", "Messaging.", "message-circle"],
    ["models", "Models", "Model providers.", "brain"],
    ["memory", "Memory", "Memory systems.", "brain"],
    ["context", "Context", "Context tools.", "book-open"],
    ["voice", "Voice", "Voice tools.", "message-square"],
    ["media", "Media", "Media tools.", "palette"],
    ["web", "Web", "Web tools.", "globe"],
    ["tools", "Tools", "Agent tools.", "wrench"],
    ["runtime", "Runtime", "Runtime tools.", "git-branch"],
    ["gateway", "Gateway", "Gateway tools.", "activity"],
    ["security", "Security", "Security tools.", "shield"],
    ["other", "Other", "Other plugins.", "package"],
  ].map(([slug, label, description, icon], order) => ({ slug, label, description, icon, order })),
};

export const calendarSearchResponse = {
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

export const matrixDetail = {
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

export const localOnlyDetail = {
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

export function configSnapshot(isWorkboardEnabled: boolean) {
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
