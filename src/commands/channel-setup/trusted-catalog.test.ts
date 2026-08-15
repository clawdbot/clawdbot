// Trusted channel catalog tests cover workspace shadow filtering and plugin auto-enable trust resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getChannelPluginCatalogEntry = vi.hoisted(() => vi.fn());
const listRawChannelPluginCatalogEntries = vi.hoisted(() => vi.fn());

vi.mock("../../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: (...args: unknown[]) =>
    getChannelPluginCatalogEntry(...(args as [string, Record<string, unknown>])),
  listRawChannelPluginCatalogEntries: (options?: unknown) =>
    listRawChannelPluginCatalogEntries(options),
}));

import {
  getTrustedChannelPluginCatalogEntry,
  listSetupDiscoveryChannelPluginCatalogEntries,
  listTrustedChannelPluginCatalogEntries,
} from "./trusted-catalog.js";

type MockCatalogOrigin = "bundled" | "config" | "global" | "workspace";

type CatalogLookupOptions = {
  extraPaths?: string[];
  excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
};

const RAW_LOAD_PATHS = [" /tmp/load-path-a ", "", "/tmp/load-path-b"];
const NORMALIZED_LOAD_PATHS = ["/tmp/load-path-a", "/tmp/load-path-b"];

function createCatalogEntry(params: {
  id: string;
  pluginId: string;
  origin: MockCatalogOrigin;
  label: string;
  blurb?: string;
  localPath: string;
}) {
  return {
    id: params.id,
    pluginId: params.pluginId,
    origin: params.origin,
    meta: {
      id: params.id,
      label: params.label,
      selectionLabel: params.label,
      docsPath: `/channels/${params.id}`,
      blurb:
        params.blurb ?? (params.origin === "bundled" ? "bundled entry" : `${params.origin} shadow`),
    },
    install: { localPath: params.localPath, defaultChoice: "local" },
  };
}

function mockCatalogFallback(params: {
  rejected: ReturnType<typeof createCatalogEntry>;
  fallback?: ReturnType<typeof createCatalogEntry>;
  expectedExtraPaths?: string[];
}) {
  getChannelPluginCatalogEntry.mockImplementation(
    (_channelId: string, options?: CatalogLookupOptions) => {
      if (params.expectedExtraPaths) {
        expect(options?.extraPaths).toEqual(params.expectedExtraPaths);
      }
      const rejected = options?.excludePluginRefs?.some(
        (entry) =>
          entry.pluginId === params.rejected.pluginId && entry.origin === params.rejected.origin,
      );
      return rejected ? params.fallback : params.rejected;
    },
  );
}

function mockTelegramShadowFallback(params: {
  pluginId: string;
  origin: Exclude<MockCatalogOrigin, "bundled">;
  localPath: string;
}) {
  mockCatalogFallback({
    rejected: createCatalogEntry({
      id: "telegram",
      pluginId: params.pluginId,
      origin: params.origin,
      label: "Telegram Shadow",
      localPath: params.localPath,
    }),
    fallback: createCatalogEntry({
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
      label: "Telegram",
      localPath: "./bundled/telegram",
    }),
  });
}

function mockTeamsConfigFallback() {
  mockCatalogFallback({
    rejected: createCatalogEntry({
      id: "msteams",
      pluginId: "config-shadow",
      origin: "config",
      label: "Shadow Teams",
      localPath: "./plugins/msteams-shadow",
    }),
    fallback: createCatalogEntry({
      id: "msteams",
      pluginId: "bundled-msteams",
      origin: "bundled",
      label: "Bundled Teams",
      localPath: "./bundled/msteams",
    }),
    expectedExtraPaths: ["/tmp/load-path-a"],
  });
}

describe("trusted-catalog load-path discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes normalized load paths into trusted single-entry resolution", () => {
    getChannelPluginCatalogEntry.mockReturnValue(
      createCatalogEntry({
        id: "e2e-load-paths",
        pluginId: "e2e-load-paths-shadow",
        origin: "config",
        label: "E2E Load Paths",
        blurb: "load-paths entry",
        localPath: "./plugins/e2e-load-paths",
      }),
    );

    expect(
      getTrustedChannelPluginCatalogEntry("e2e-load-paths", {
        cfg: {
          plugins: {
            allow: ["e2e-load-paths-shadow"],
            load: {
              paths: RAW_LOAD_PATHS,
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "e2e-load-paths",
      pluginId: "e2e-load-paths-shadow",
    });

    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("e2e-load-paths", {
      env: undefined,
      extraPaths: NORMALIZED_LOAD_PATHS,
      workspaceDir: "/tmp/workspace",
    });
  });

  it.each([
    [
      "passes normalized load paths into trusted catalog listing and fallback lookup",
      listTrustedChannelPluginCatalogEntries,
    ],
    [
      "passes normalized load paths into setup discovery listing",
      listSetupDiscoveryChannelPluginCatalogEntries,
    ],
  ])("%s", (_title, listEntries) => {
    listRawChannelPluginCatalogEntries.mockImplementation(
      (options?: { excludeWorkspace?: boolean; extraPaths?: string[] }) => {
        expect(options?.extraPaths).toEqual(NORMALIZED_LOAD_PATHS);
        return [];
      },
    );

    expect(
      listEntries({
        cfg: { plugins: { load: { paths: RAW_LOAD_PATHS } } },
        workspaceDir: "/tmp/workspace",
      }),
    ).toStrictEqual([]);
    expect(listRawChannelPluginCatalogEntries).toHaveBeenNthCalledWith(1, {
      env: undefined,
      extraPaths: NORMALIZED_LOAD_PATHS,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("falls back past an untrusted config-origin shadow to the bundled entry", () => {
    mockTeamsConfigFallback();

    expect(
      getTrustedChannelPluginCatalogEntry("msteams", {
        cfg: {
          plugins: {
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "msteams",
      pluginId: "bundled-msteams",
      origin: "bundled",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "msteams", {
      env: undefined,
      extraPaths: ["/tmp/load-path-a"],
      workspaceDir: "/tmp/workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "msteams", {
      excludePluginRefs: [{ pluginId: "config-shadow", origin: "config" }],
      env: undefined,
      extraPaths: ["/tmp/load-path-a"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps origin-specific fallback when local and bundled entries share a plugin id", () => {
    mockCatalogFallback({
      rejected: createCatalogEntry({
        id: "telegram",
        pluginId: "telegram",
        origin: "config",
        label: "Telegram Shadow",
        localPath: "./plugins/telegram-shadow",
      }),
      fallback: createCatalogEntry({
        id: "telegram",
        pluginId: "telegram",
        origin: "bundled",
        label: "Telegram",
        localPath: "./bundled/telegram",
      }),
    });

    expect(
      getTrustedChannelPluginCatalogEntry("telegram", {
        cfg: {
          plugins: {
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "telegram",
      pluginId: "telegram",
      origin: "bundled",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "telegram", {
      excludePluginRefs: [{ pluginId: "telegram", origin: "config" }],
      env: undefined,
      extraPaths: ["/tmp/load-path-a"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("stops when fallback lookup resurfaces the same untrusted local entry", () => {
    getChannelPluginCatalogEntry.mockReturnValue(
      createCatalogEntry({
        id: "msteams",
        pluginId: "config-shadow",
        origin: "config",
        label: "Shadow Teams",
        localPath: "./plugins/msteams-shadow",
      }),
    );

    expect(
      getTrustedChannelPluginCatalogEntry("msteams", {
        cfg: {
          plugins: {
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toBeUndefined();
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(2);
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "msteams", {
      excludePluginRefs: [{ pluginId: "config-shadow", origin: "config" }],
      env: undefined,
      extraPaths: ["/tmp/load-path-a"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("keeps setup discovery visible when an untrusted config-origin entry has no fallback", () => {
    const rejected = createCatalogEntry({
      id: "e2e-load-paths",
      pluginId: "config-shadow",
      origin: "config",
      label: "E2E Load Paths",
      localPath: "./plugins/e2e-load-paths",
    });
    listRawChannelPluginCatalogEntries.mockReturnValue([rejected]);
    mockCatalogFallback({ rejected, expectedExtraPaths: ["/tmp/load-path-a"] });

    expect(
      listSetupDiscoveryChannelPluginCatalogEntries({
        cfg: {
          plugins: {
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toHaveLength(1);
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "e2e-load-paths", {
      excludePluginRefs: [{ pluginId: "config-shadow", origin: "config" }],
      env: undefined,
      extraPaths: ["/tmp/load-path-a"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("falls back past a denylisted config-origin shadow even when it is explicitly allowed", () => {
    mockTeamsConfigFallback();

    expect(
      getTrustedChannelPluginCatalogEntry("msteams", {
        cfg: {
          plugins: {
            allow: ["config-shadow"],
            deny: ["config-shadow"],
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "msteams",
      pluginId: "bundled-msteams",
      origin: "bundled",
    });
  });

  it("falls back past an auto-enabled config-origin shadow", () => {
    mockTelegramShadowFallback({
      pluginId: "config-shadow",
      origin: "config",
      localPath: "./plugins/telegram-shadow",
    });

    expect(
      getTrustedChannelPluginCatalogEntry("telegram", {
        cfg: {
          channels: {
            telegram: {
              enabled: true,
            },
          },
          plugins: {
            load: {
              paths: ["/tmp/load-path-a"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
    });
  });

  it("falls back past an untrusted global shadow to the bundled entry", () => {
    mockTelegramShadowFallback({
      pluginId: "global-shadow",
      origin: "global",
      localPath: "./state/extensions/telegram",
    });

    expect(
      getTrustedChannelPluginCatalogEntry("telegram", {
        cfg: {
          plugins: {
            enabled: true,
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
    });
  });

  it("falls back past an explicitly disabled workspace shadow", () => {
    mockTelegramShadowFallback({
      pluginId: "workspace-shadow",
      origin: "workspace",
      localPath: "./workspace/telegram",
    });

    expect(
      getTrustedChannelPluginCatalogEntry("telegram", {
        cfg: {
          plugins: {
            allow: ["workspace-shadow"],
            entries: {
              "workspace-shadow": { enabled: false },
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toMatchObject({
      id: "telegram",
      pluginId: "@openclaw/telegram",
      origin: "bundled",
    });
  });

  it("forwards caller env when resolving load paths", () => {
    getChannelPluginCatalogEntry.mockReturnValue(undefined);

    getTrustedChannelPluginCatalogEntry("e2e-load-paths", {
      cfg: {
        plugins: {
          load: {
            paths: ["$OPENCLAW_HOME/custom-plugin"],
          },
        },
      },
      env: {
        ...process.env,
        OPENCLAW_HOME: "/tmp/custom-home",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("e2e-load-paths", {
      env: expect.objectContaining({
        OPENCLAW_HOME: "/tmp/custom-home",
      }),
      extraPaths: ["$OPENCLAW_HOME/custom-plugin"],
      workspaceDir: "/tmp/workspace",
    });
  });
});
