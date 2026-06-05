// Trusted channel catalog tests cover workspace shadow filtering and plugin auto-enable trust resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";

const listRawChannelPluginCatalogEntries = vi.hoisted(() =>
  vi.fn((_opts?: unknown): ChannelPluginCatalogEntry[] => []),
);
const getChannelPluginCatalogEntry = vi.hoisted(() =>
  vi.fn((_id?: unknown, _opts?: unknown): ChannelPluginCatalogEntry | undefined => undefined),
);
const applyPluginAutoEnable = vi.hoisted(() =>
  vi.fn(({ config }: { config: unknown }) => ({
    config: config as never,
    changes: [] as string[],
    autoEnabledReasons: {},
  })),
);

vi.mock("../../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: (opts?: unknown) => listRawChannelPluginCatalogEntries(opts),
  getChannelPluginCatalogEntry: (id?: unknown, opts?: unknown) =>
    getChannelPluginCatalogEntry(id, opts),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (args: unknown) =>
    applyPluginAutoEnable(args as { config: unknown; env?: NodeJS.ProcessEnv }),
}));

import {
  getTrustedChannelPluginCatalogEntry,
  listSetupDiscoveryChannelPluginCatalogEntries,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin?: "workspace" | "bundled";
}): ChannelPluginCatalogEntry {
  return {
    id: params.id,
    pluginId: params.pluginId,
    origin: params.origin,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      docsPath: `/channels/${params.id}`,
      blurb: `${params.id} channel`,
    },
    install: {
      npmSpec: params.pluginId,
    },
  };
}

describe("trusted catalog helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyPluginAutoEnable.mockImplementation(({ config }: { config: unknown }) => ({
      config: config as never,
      changes: [] as string[],
      autoEnabledReasons: {},
    }));
  });

  it("falls back to the bundled entry for an untrusted workspace shadow", () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "evil-telegram-shadow",
      origin: "workspace",
    });
    const bundledEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
    });
    getChannelPluginCatalogEntry
      .mockReturnValueOnce(workspaceEntry)
      .mockReturnValueOnce(bundledEntry);

    const result = getTrustedChannelPluginCatalogEntry("telegram", {
      cfg: {} as never,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(result?.pluginId).toBe("telegram");
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "telegram", {
      workspaceDir: "/tmp/workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "telegram", {
      workspaceDir: "/tmp/workspace",
      excludeWorkspace: true,
    });
  });

  it("keeps trusted workspace overrides eligible", () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "trusted-telegram-shadow",
      origin: "workspace",
    });
    getChannelPluginCatalogEntry.mockReturnValue(workspaceEntry);

    const result = getTrustedChannelPluginCatalogEntry("telegram", {
      cfg: {
        plugins: {
          enabled: true,
          allow: ["trusted-telegram-shadow"],
        },
      } as never,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(result?.pluginId).toBe("trusted-telegram-shadow");
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(1);
  });

  it("omits untrusted workspace-only entries from the trusted list", () => {
    const workspaceOnlyEntry = createCatalogEntry({
      id: "my-cool-plugin",
      pluginId: "my-cool-plugin",
      origin: "workspace",
    });
    listRawChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? []
        : [workspaceOnlyEntry],
    );

    const result = listTrustedChannelPluginCatalogEntries({
      cfg: {} as never,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(result).toEqual([]);
  });

  it("keeps workspace-only install candidates visible in discovery", () => {
    const workspaceOnlyEntry = createCatalogEntry({
      id: "my-cool-plugin",
      pluginId: "my-cool-plugin",
      origin: "workspace",
    });
    listRawChannelPluginCatalogEntries.mockImplementation((opts?: unknown) =>
      (opts as { excludeWorkspace?: boolean } | undefined)?.excludeWorkspace
        ? []
        : [workspaceOnlyEntry],
    );

    const result = listSetupDiscoveryChannelPluginCatalogEntries({
      cfg: {} as never,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(result.map((entry) => entry.pluginId)).toEqual(["my-cool-plugin"]);
  });

  it("treats auto-enabled workspace plugins as trusted", () => {
    const workspaceEntry = createCatalogEntry({
      id: "telegram",
      pluginId: "trusted-telegram-shadow",
      origin: "workspace",
    });
    getChannelPluginCatalogEntry.mockReturnValue(workspaceEntry);
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

    const result = getTrustedChannelPluginCatalogEntry("telegram", {
      cfg: {
        channels: {
          telegram: { token: "existing-token" },
        },
      } as never,
      workspaceDir: "/tmp/workspace",
      env: process.env,
    });

    expect(result?.pluginId).toBe("trusted-telegram-shadow");
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(1);
  });
});
