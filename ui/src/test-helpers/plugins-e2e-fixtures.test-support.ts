import type { PluginDiscoveryEntry, PluginDiscoveryResult } from "../lib/plugins/index.ts";

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
    install: { source: "official", pluginId: "local-calendar" },
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
