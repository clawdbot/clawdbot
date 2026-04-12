/**
 * Regression tests for GHSA-2qrv-rc5x-2g2h incomplete-fix bypass.
 *
 * The original fix added trusted fallback behavior to two call sites in
 * channel-plugin-resolution.ts. Three other setup-flow call sites were
 * missed. These tests verify setup discovery falls back from untrusted
 * workspace shadows without hiding trusted workspace plugins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted to module top level)
// ---------------------------------------------------------------------------

const listChannelPluginCatalogEntries = vi.hoisted(() => vi.fn((_opts?: unknown): unknown[] => []));
const listChatChannels = vi.hoisted(() => vi.fn((): unknown[] => []));
const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }: { config: unknown }) => ({
    config: config as never,
    changes: [] as string[],
    autoEnabledReasons: {},
  })),
);
const getChannelPluginCatalogEntry = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/catalog.js", () => ({
  listChannelPluginCatalogEntries: (opts?: unknown) => listChannelPluginCatalogEntries(opts),
  getChannelPluginCatalogEntry: (...args: unknown[]) =>
    getChannelPluginCatalogEntry(...(args as [string, Record<string, unknown>])),
}));
vi.mock("../../channels/registry.js", () => ({
  listChatChannels: () => listChatChannels(),
}));
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...a: unknown[]) => loadPluginManifestRegistry(...a),
}));
vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (a: unknown) => applyPluginAutoEnable(a as { config: unknown }),
}));
vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
}));

import { resolveChannelSetupEntries } from "./discovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  listChatChannels.mockReturnValue([]);
});

function createWorkspaceCatalogEntry(id: string, label: string) {
  return {
    id,
    pluginId: id,
    origin: "workspace",
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: "/",
      blurb: "t",
      order: 1,
    },
    install: { npmSpec: id },
  };
}

function mockWorkspaceOnlyCatalogEntry(entry: ReturnType<typeof createWorkspaceCatalogEntry>) {
  listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
    (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace ? [] : [entry],
  );
}

// ---------------------------------------------------------------------------
// Regression: resolveChannelSetupEntries (discovery.ts)
// ---------------------------------------------------------------------------

describe("resolveChannelSetupEntries workspace shadow exclusion (GHSA-2qrv-rc5x-2g2h)", () => {
  it("falls back to the bundled entry for untrusted workspace shadows", () => {
    const workspaceEntry = {
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/",
        blurb: "t",
        order: 1,
      },
      install: { npmSpec: "evil-telegram-shadow" },
    };
    const bundledEntry = {
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
      meta: workspaceEntry.meta,
      install: { npmSpec: "@openclaw/telegram" },
    };
    listChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? [bundledEntry]
        : [workspaceEntry],
    );

    resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const fallbackCall = listChannelPluginCatalogEntries.mock.calls.find(
      ([opts]) => (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace === true,
    );
    expect(fallbackCall).toBeTruthy();
  });

  it("still returns bundled-origin entries", () => {
    const bundledEntry = {
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/",
        blurb: "t",
        order: 1,
      },
      install: { npmSpec: "@openclaw/telegram" },
    };
    listChannelPluginCatalogEntries.mockReturnValue([bundledEntry]);

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    const allIds = [
      ...result.installedCatalogEntries.map((e: { id: string }) => e.id),
      ...result.installableCatalogEntries.map((e: { id: string }) => e.id),
    ];
    expect(allIds).toContain("telegram");
  });

  it("keeps trusted workspace channel plugins visible in setup", () => {
    const workspaceEntry = {
      id: "telegram",
      pluginId: "trusted-telegram-shadow",
      origin: "workspace",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/",
        blurb: "t",
        order: 1,
      },
      install: { npmSpec: "trusted-telegram-shadow" },
    };
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "trusted-telegram-shadow", channels: ["telegram"] }],
      diagnostics: [],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installedCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["trusted-telegram-shadow"]);
  });

  it("treats auto-enabled workspace channel plugins as trusted during setup discovery", () => {
    const workspaceEntry = {
      id: "telegram",
      pluginId: "trusted-telegram-shadow",
      origin: "workspace",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/",
        blurb: "t",
        order: 1,
      },
      install: { npmSpec: "trusted-telegram-shadow" },
    };
    listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      config: {
        ...(config as Record<string, unknown>),
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      changes: ["trusted-telegram-shadow"] as string[],
      autoEnabledReasons: {
        "trusted-telegram-shadow": ["channel configured"],
      },
    }));
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "trusted-telegram-shadow", channels: ["telegram"] }],
      diagnostics: [],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        channels: {
          telegram: { token: "existing-token" },
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installedCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["trusted-telegram-shadow"]);
  });

  it("keeps workspace-only install candidates visible until the user trusts them", () => {
    mockWorkspaceOnlyCatalogEntry(createWorkspaceCatalogEntry("my-cool-plugin", "My Cool Plugin"));

    const result = resolveChannelSetupEntries({
      cfg: {} as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(
      result.installableCatalogEntries.map((entry: { pluginId?: string }) => entry.pluginId),
    ).toEqual(["my-cool-plugin"]);
  });

  it("does not surface untrusted workspace-only entries as installed", () => {
    mockWorkspaceOnlyCatalogEntry(createWorkspaceCatalogEntry("my-cool-plugin", "My Cool Plugin"));
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      config: {
        ...(config as Record<string, unknown>),
        plugins: {},
      } as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }));
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [{ id: "my-cool-plugin", channels: ["my-cool-plugin"] }],
      diagnostics: [],
    });

    const result = resolveChannelSetupEntries({
      cfg: {
        channels: {
          "my-cool-plugin": { token: "existing-token" },
        },
      } as never,
      env: process.env,
      installedPlugins: [],
    });

    expect(result.installedCatalogEntries).toEqual([]);
    expect(result.installableCatalogEntries).toEqual([]);
  });
});
