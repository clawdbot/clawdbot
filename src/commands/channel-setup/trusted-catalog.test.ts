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

describe("trusted-catalog load-path discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes normalized load paths into trusted single-entry resolution", () => {
    getChannelPluginCatalogEntry.mockReturnValue({
      id: "e2e-load-paths",
      pluginId: "e2e-load-paths-shadow",
      origin: "config",
      meta: {
        id: "e2e-load-paths",
        label: "E2E Load Paths",
        selectionLabel: "E2E Load Paths",
        docsPath: "/channels/e2e-load-paths",
        blurb: "load-paths entry",
      },
      install: { localPath: "./plugins/e2e-load-paths", defaultChoice: "local" },
    });

    expect(
      getTrustedChannelPluginCatalogEntry("e2e-load-paths", {
        cfg: {
          plugins: {
            allow: ["e2e-load-paths-shadow"],
            load: {
              paths: [" /tmp/load-path-a ", "", "/tmp/load-path-b"],
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
      extraPaths: ["/tmp/load-path-a", "/tmp/load-path-b"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("passes normalized load paths into trusted catalog listing and fallback lookup", () => {
    listRawChannelPluginCatalogEntries.mockImplementation(
      (options?: { excludeWorkspace?: boolean; extraPaths?: string[] }) => {
        expect(options?.extraPaths).toEqual(["/tmp/load-path-a", "/tmp/load-path-b"]);
        return [];
      },
    );

    expect(
      listTrustedChannelPluginCatalogEntries({
        cfg: {
          plugins: {
            load: {
              paths: [" /tmp/load-path-a ", "", "/tmp/load-path-b"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toStrictEqual([]);
    expect(listRawChannelPluginCatalogEntries).toHaveBeenNthCalledWith(1, {
      env: undefined,
      extraPaths: ["/tmp/load-path-a", "/tmp/load-path-b"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("passes normalized load paths into setup discovery listing", () => {
    listRawChannelPluginCatalogEntries.mockImplementation(
      (options?: { excludeWorkspace?: boolean; extraPaths?: string[] }) => {
        expect(options?.extraPaths).toEqual(["/tmp/load-path-a", "/tmp/load-path-b"]);
        return [];
      },
    );

    expect(
      listSetupDiscoveryChannelPluginCatalogEntries({
        cfg: {
          plugins: {
            load: {
              paths: [" /tmp/load-path-a ", "", "/tmp/load-path-b"],
            },
          },
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toStrictEqual([]);
    expect(listRawChannelPluginCatalogEntries).toHaveBeenNthCalledWith(1, {
      env: undefined,
      extraPaths: ["/tmp/load-path-a", "/tmp/load-path-b"],
      workspaceDir: "/tmp/workspace",
    });
  });

  it("falls back past an untrusted config-origin shadow to the bundled entry", () => {
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          extraPaths?: string[];
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) => {
        expect(options?.extraPaths).toEqual(["/tmp/load-path-a"]);
        if (
          options?.excludePluginRefs?.some(
            (entry) => entry.pluginId === "config-shadow" && entry.origin === "config",
          )
        ) {
          return {
            id: "msteams",
            pluginId: "bundled-msteams",
            origin: "bundled",
            meta: {
              id: "msteams",
              label: "Bundled Teams",
              selectionLabel: "Bundled Teams",
              docsPath: "/channels/msteams",
              blurb: "bundled entry",
            },
            install: { localPath: "./bundled/msteams", defaultChoice: "local" },
          };
        }
        return {
          id: "msteams",
          pluginId: "config-shadow",
          origin: "config",
          meta: {
            id: "msteams",
            label: "Shadow Teams",
            selectionLabel: "Shadow Teams",
            docsPath: "/channels/msteams",
            blurb: "config shadow",
          },
          install: { localPath: "./plugins/msteams-shadow", defaultChoice: "local" },
        };
      },
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
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) => {
        if (
          options?.excludePluginRefs?.some(
            (entry) => entry.pluginId === "telegram" && entry.origin === "config",
          )
        ) {
          return {
            id: "telegram",
            pluginId: "telegram",
            origin: "bundled",
            meta: {
              id: "telegram",
              label: "Telegram",
              selectionLabel: "Telegram",
              docsPath: "/channels/telegram",
              blurb: "bundled entry",
            },
            install: { localPath: "./bundled/telegram", defaultChoice: "local" },
          };
        }
        return {
          id: "telegram",
          pluginId: "telegram",
          origin: "config",
          meta: {
            id: "telegram",
            label: "Telegram Shadow",
            selectionLabel: "Telegram Shadow",
            docsPath: "/channels/telegram",
            blurb: "config shadow",
          },
          install: { localPath: "./plugins/telegram-shadow", defaultChoice: "local" },
        };
      },
    );

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
    getChannelPluginCatalogEntry.mockReturnValue({
      id: "msteams",
      pluginId: "config-shadow",
      origin: "config",
      meta: {
        id: "msteams",
        label: "Shadow Teams",
        selectionLabel: "Shadow Teams",
        docsPath: "/channels/msteams",
        blurb: "config shadow",
      },
      install: { localPath: "./plugins/msteams-shadow", defaultChoice: "local" },
    });

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
    listRawChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "e2e-load-paths",
        pluginId: "config-shadow",
        origin: "config",
        meta: {
          id: "e2e-load-paths",
          label: "E2E Load Paths",
          selectionLabel: "E2E Load Paths",
          docsPath: "/channels/e2e-load-paths",
          blurb: "config shadow",
        },
        install: { localPath: "./plugins/e2e-load-paths", defaultChoice: "local" },
      },
    ]);
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          extraPaths?: string[];
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) => {
        expect(options?.extraPaths).toEqual(["/tmp/load-path-a"]);
        return options?.excludePluginRefs?.some(
          (entry) => entry.pluginId === "config-shadow" && entry.origin === "config",
        )
          ? undefined
          : {
              id: "e2e-load-paths",
              pluginId: "config-shadow",
              origin: "config",
              meta: {
                id: "e2e-load-paths",
                label: "E2E Load Paths",
                selectionLabel: "E2E Load Paths",
                docsPath: "/channels/e2e-load-paths",
                blurb: "config shadow",
              },
              install: { localPath: "./plugins/e2e-load-paths", defaultChoice: "local" },
            };
      },
    );

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
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          extraPaths?: string[];
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) => {
        expect(options?.extraPaths).toEqual(["/tmp/load-path-a"]);
        if (
          options?.excludePluginRefs?.some(
            (entry) => entry.pluginId === "config-shadow" && entry.origin === "config",
          )
        ) {
          return {
            id: "msteams",
            pluginId: "bundled-msteams",
            origin: "bundled",
            meta: {
              id: "msteams",
              label: "Bundled Teams",
              selectionLabel: "Bundled Teams",
              docsPath: "/channels/msteams",
              blurb: "bundled entry",
            },
            install: { localPath: "./bundled/msteams", defaultChoice: "local" },
          };
        }
        return {
          id: "msteams",
          pluginId: "config-shadow",
          origin: "config",
          meta: {
            id: "msteams",
            label: "Shadow Teams",
            selectionLabel: "Shadow Teams",
            docsPath: "/channels/msteams",
            blurb: "config shadow",
          },
          install: { localPath: "./plugins/msteams-shadow", defaultChoice: "local" },
        };
      },
    );

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
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) =>
        options?.excludePluginRefs?.some(
          (entry) => entry.pluginId === "config-shadow" && entry.origin === "config",
        )
          ? {
              id: "telegram",
              pluginId: "@openclaw/telegram",
              origin: "bundled",
              meta: {
                id: "telegram",
                label: "Telegram",
                selectionLabel: "Telegram",
                docsPath: "/channels/telegram",
                blurb: "bundled entry",
              },
              install: { localPath: "./bundled/telegram", defaultChoice: "local" },
            }
          : {
              id: "telegram",
              pluginId: "config-shadow",
              origin: "config",
              meta: {
                id: "telegram",
                label: "Telegram Shadow",
                selectionLabel: "Telegram Shadow",
                docsPath: "/channels/telegram",
                blurb: "config shadow",
              },
              install: { localPath: "./plugins/telegram-shadow", defaultChoice: "local" },
            },
    );

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
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) =>
        options?.excludePluginRefs?.some(
          (entry) => entry.pluginId === "global-shadow" && entry.origin === "global",
        )
          ? {
              id: "telegram",
              pluginId: "@openclaw/telegram",
              origin: "bundled",
              meta: {
                id: "telegram",
                label: "Telegram",
                selectionLabel: "Telegram",
                docsPath: "/channels/telegram",
                blurb: "bundled entry",
              },
              install: { localPath: "./bundled/telegram", defaultChoice: "local" },
            }
          : {
              id: "telegram",
              pluginId: "global-shadow",
              origin: "global",
              meta: {
                id: "telegram",
                label: "Telegram Shadow",
                selectionLabel: "Telegram Shadow",
                docsPath: "/channels/telegram",
                blurb: "global shadow",
              },
              install: { localPath: "./state/extensions/telegram", defaultChoice: "local" },
            },
    );

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
    getChannelPluginCatalogEntry.mockImplementation(
      (
        _channelId: string,
        options?: {
          excludePluginRefs?: Array<{ pluginId: string; origin?: string }>;
          workspaceDir?: string;
        },
      ) =>
        options?.excludePluginRefs?.some(
          (entry) => entry.pluginId === "workspace-shadow" && entry.origin === "workspace",
        )
          ? {
              id: "telegram",
              pluginId: "@openclaw/telegram",
              origin: "bundled",
              meta: {
                id: "telegram",
                label: "Telegram",
                selectionLabel: "Telegram",
                docsPath: "/channels/telegram",
                blurb: "bundled entry",
              },
              install: { localPath: "./bundled/telegram", defaultChoice: "local" },
            }
          : {
              id: "telegram",
              pluginId: "workspace-shadow",
              origin: "workspace",
              meta: {
                id: "telegram",
                label: "Telegram Shadow",
                selectionLabel: "Telegram Shadow",
                docsPath: "/channels/telegram",
                blurb: "workspace shadow",
              },
              install: { localPath: "./workspace/telegram", defaultChoice: "local" },
            },
    );

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
