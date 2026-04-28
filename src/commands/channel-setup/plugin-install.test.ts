import path from "node:path";
import { bundledPluginRoot, bundledPluginRootAt } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const existsSync = vi.fn();
  const realpathSync = vi.fn(actual.realpathSync);
  const statSync = vi.fn(actual.statSync);
  return {
    ...actual,
    existsSync,
    realpathSync,
    statSync,
    default: {
      ...actual,
      existsSync,
      realpathSync,
      statSync,
    },
  };
});

const execFileSync = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSync(...args),
  };
});

const installPluginFromNpmSpec = vi.fn();
const applyPluginAutoEnable = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (...args: unknown[]) => installPluginFromNpmSpec(...args),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnable(...args),
}));

const resolveBundledPluginSources = vi.fn();
const getChannelPluginCatalogEntry = vi.fn();
const listChannelPluginCatalogEntries = vi.fn((..._args: unknown[]) => []);
vi.mock("../../channels/plugins/catalog.js", () => {
  return {
    getChannelPluginCatalogEntry: (...args: unknown[]) => getChannelPluginCatalogEntry(...args),
    listChannelPluginCatalogEntries: (...args: unknown[]) =>
      listChannelPluginCatalogEntries(...args),
  };
});

const loadPluginManifestRegistry = vi.fn();
vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistry(...args),
}));

vi.mock("../../plugins/bundled-sources.js", () => ({
  findBundledPluginSourceInMap: ({
    bundled,
    lookup,
  }: {
    bundled: ReadonlyMap<string, { pluginId: string; localPath: string; npmSpec?: string }>;
    lookup: { kind: "pluginId" | "npmSpec"; value: string };
  }) => {
    const targetValue = lookup.value.trim();
    if (!targetValue) {
      return undefined;
    }
    if (lookup.kind === "pluginId") {
      return bundled.get(targetValue);
    }
    for (const source of bundled.values()) {
      if (source.npmSpec === targetValue) {
        return source;
      }
    }
    return undefined;
  },
  resolveBundledPluginSources: (...args: unknown[]) => resolveBundledPluginSources(...args),
}));

vi.mock("../../plugins/loader.js", () => ({
  loadOpenClawPlugins: vi.fn(),
}));

const clearPluginDiscoveryCache = vi.fn();
const discoverOpenClawPlugins = vi.fn((_args?: unknown) => ({ candidates: [], diagnostics: [] }));
vi.mock("../../plugins/discovery.js", () => ({
  clearPluginDiscoveryCache: () => clearPluginDiscoveryCache(),
  discoverOpenClawPlugins: (args: unknown) => discoverOpenClawPlugins(args),
}));

import fs from "node:fs";
import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import {
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "../setup/__tests__/test-utils.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
  reloadChannelSetupPluginRegistry,
  reloadChannelSetupPluginRegistryForChannel,
} from "./plugin-install.js";

const bundledChatNpmSpec = "@openclaw/bundled-chat@1.2.3";
const bundledChatIntegrity = "sha512-bundled-chat";
const bundledChatForkNpmSpec = "@vendor/bundled-chat-fork@1.2.3";
const bundledChatForkIntegrity = "sha512-vendor-bundled-chat-fork";
const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

const baseEntry: ChannelPluginCatalogEntry = {
  id: "bundled-chat",
  pluginId: "bundled-chat",
  meta: {
    id: "bundled-chat",
    label: "Bundled Chat",
    selectionLabel: "Bundled Chat",
    docsPath: "/channels/bundled-chat",
    docsLabel: "bundled chat",
    blurb: "Test",
  },
  install: {
    npmSpec: bundledChatNpmSpec,
    localPath: bundledPluginRoot("bundled-chat"),
    expectedIntegrity: bundledChatIntegrity,
  },
};

function mockBundledChatSource() {
  resolveBundledPluginSources.mockReturnValue(
    new Map([
      [
        "bundled-chat",
        {
          pluginId: "bundled-chat",
          localPath: bundledPluginRootAt("/opt/openclaw", "bundled-chat"),
          npmSpec: bundledChatNpmSpec,
        },
      ],
    ]),
  );
}

function makeSkipInstallPrompter() {
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
  return { prompter, select };
}

function mockActivationOnlyPlugin(plugin: {
  id: string;
  origin?: "bundled" | "global" | "workspace";
}) {
  loadPluginManifestRegistry.mockReturnValue({
    plugins: [
      createManifestRecord({
        id: plugin.id,
        ...(plugin.origin === undefined ? {} : { origin: plugin.origin }),
        activation: {
          onChannels: ["external-chat"],
        },
      }),
    ],
    diagnostics: [],
  });
}

function createManifestRecord(
  overrides: Partial<PluginManifestRecord> & Pick<PluginManifestRecord, "id">,
): PluginManifestRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    syntheticAuthRefs: [],
    nonSecretAuthMarkers: [],
    skills: [],
    hooks: [],
    origin: "bundled",
    rootDir: `/tmp/openclaw-test/${id}`,
    source: `/tmp/openclaw-test/${id}/index.ts`,
    manifestPath: `/tmp/openclaw-test/${id}/openclaw.plugin.json`,
    ...rest,
  };
}

function expectSetupSnapshotDoesNotScopeToPlugin(params: {
  cfg: OpenClawConfig;
  runtime: ReturnType<typeof makeRuntime>;
  pluginId: string;
}) {
  loadChannelSetupPluginRegistrySnapshotForChannel({
    cfg: params.cfg,
    runtime: params.runtime,
    channel: "external-chat",
    workspaceDir: "/tmp/openclaw-workspace",
  });

  expect(loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.not.objectContaining({
      onlyPluginIds: [params.pluginId],
    }),
  );
  const firstLoadCall = vi.mocked(loadOpenClawPlugins).mock.calls[0]?.[0] as
    | { onlyPluginIds?: string[] }
    | undefined;
  expect(firstLoadCall?.onlyPluginIds).toBeUndefined();
}

beforeEach(() => {
  vi.clearAllMocks();
  execFileSync.mockImplementation(() => {
    throw new Error("not a git worktree");
  });
  applyPluginAutoEnable.mockImplementation((params: { config: unknown }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  }));
  resolveBundledPluginSources.mockReturnValue(new Map());
  discoverOpenClawPlugins.mockReturnValue({ candidates: [], diagnostics: [] });
  getChannelPluginCatalogEntry.mockReturnValue(undefined);
  listChannelPluginCatalogEntries.mockReturnValue([]);
  loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  if (ORIGINAL_OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
  }
});

function mockRepoLocalPathExists() {
  execFileSync.mockImplementation((command: string, args: string[]) => {
    expect(command).toBe("git");
    expect(args[1]).toBe(process.cwd());
    expect(args[2]).toBe("rev-parse");
    const request = args.slice(3).join(" ");
    if (request === "--is-inside-work-tree") {
      return "true\n";
    }
    if (request === "--path-format=absolute --show-toplevel") {
      return `${process.cwd()}\n`;
    }
    if (request === "--path-format=absolute --git-common-dir") {
      return `${process.cwd()}\n`;
    }
    throw new Error(`unexpected git args: ${request}`);
  });
  vi.mocked(fs.realpathSync).mockImplementation(((value: fs.PathLike) => {
    const raw = String(value);
    if (raw.endsWith(`${path.sep}extensions${path.sep}bundled-chat`)) {
      return path.resolve(process.cwd(), bundledPluginRoot("bundled-chat"));
    }
    return raw;
  }) as typeof fs.realpathSync);
  vi.mocked(fs.statSync).mockImplementation(((value: fs.PathLike) => {
    const raw = String(value);
    if (raw.endsWith(`${path.sep}extensions${path.sep}bundled-chat`)) {
      return {
        isDirectory: () => true,
      } as ReturnType<typeof fs.statSync>;
    }
    return {
      isDirectory: () => true,
    } as ReturnType<typeof fs.statSync>;
  }) as typeof fs.statSync);
  vi.mocked(fs.existsSync).mockImplementation((value) => {
    const raw = String(value);
    return (
      raw.endsWith(`${path.sep}.git${path.sep}HEAD`) ||
      raw.endsWith(`${path.sep}.git${path.sep}objects`) ||
      raw.endsWith(`${path.sep}.git${path.sep}refs`) ||
      raw.endsWith(`${path.sep}extensions${path.sep}bundled-chat`)
    );
  });
}

async function runInitialValueForChannel(channel: "dev" | "beta") {
  const runtime = makeRuntime();
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
  const cfg: OpenClawConfig = { update: { channel } };
  mockRepoLocalPathExists();

  await ensureChannelSetupPluginInstalled({
    cfg,
    entry: baseEntry,
    prompter,
    runtime,
  });

  const call = select.mock.calls[0];
  return call?.[0]?.initialValue;
}

function expectPluginLoadedFromLocalPath(
  result: Awaited<ReturnType<typeof ensureChannelSetupPluginInstalled>>,
) {
  const expectedPath = path.resolve(process.cwd(), bundledPluginRoot("bundled-chat"));
  expect(result.installed).toBe(true);
  expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
}

describe("ensureChannelSetupPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = { plugins: { allow: ["bundled-chat"] } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "bundled-chat",
      targetDir: "/tmp/bundled-chat",
      extensions: [],
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toContain("bundled-chat");
    expect(result.cfg.plugins?.installs).toEqual({
      "bundled-chat": expect.objectContaining({
        source: "npm",
        spec: bundledChatNpmSpec,
        installPath: "/tmp/bundled-chat",
      }),
    });
    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedIntegrity: bundledChatIntegrity,
        spec: bundledChatNpmSpec,
      }),
    );
  });

  it("installs npm channel plugins into the active profile extensions dir", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
    });
    const profileStateDir = "/tmp/openclaw-ledger-channel";
    process.env.OPENCLAW_STATE_DIR = profileStateDir;
    vi.mocked(fs.existsSync).mockReturnValue(false);
    installPluginFromNpmSpec.mockResolvedValue({
      ok: true,
      pluginId: "bundled-chat",
      targetDir: path.join(profileStateDir, "extensions", "bundled-chat"),
      extensions: [],
    });

    await ensureChannelSetupPluginInstalled({
      cfg: {},
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(installPluginFromNpmSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionsDir: path.join(profileStateDir, "extensions"),
        spec: bundledChatNpmSpec,
      }),
    );
  });

  it("uses local path when selected", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
  });

  it("uses the catalog plugin id for local-path installs", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        ...baseEntry,
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
      },
      prompter,
      runtime,
    });

    expect(result.installed).toBe(true);
    expect(result.pluginId).toBe("@vendor/external-chat-plugin");
    expect(result.cfg.plugins?.entries?.["@vendor/external-chat-plugin"]?.enabled).toBe(true);
  });

  it("defaults to local on dev channel when local path exists", async () => {
    expect(await runInitialValueForChannel("dev")).toBe("local");
  });

  it("defaults to npm on beta channel even when local path exists", async () => {
    expect(await runInitialValueForChannel("beta")).toBe("npm");
  });

  it("defaults to bundled local path on beta channel when available", async () => {
    const runtime = makeRuntime();
    const { prompter, select } = makeSkipInstallPrompter();
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockBundledChatSource();

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "local",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "local",
            hint: bundledPluginRootAt("/opt/openclaw", "bundled-chat"),
          }),
        ]),
      }),
    );
  });

  it("uses the bundled default install source without prompting in non-interactive mode", async () => {
    const runtime = makeRuntime();
    const { prompter, select } = makeSkipInstallPrompter();
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    mockBundledChatSource();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
      promptInstall: false,
    });

    expect(select).not.toHaveBeenCalled();
    expect(result.installed).toBe(true);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
    expect(result.cfg.plugins?.load?.paths).toBeUndefined();
    expect(result.cfg.plugins?.installs).toBeUndefined();
  });

  it("does not default to bundled local path when an external catalog overrides the npm spec", async () => {
    const runtime = makeRuntime();
    const { prompter, select } = makeSkipInstallPrompter();
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    vi.mocked(fs.existsSync).mockReturnValue(false);
    mockBundledChatSource();

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        id: "bundled-chat",
        meta: {
          id: "bundled-chat",
          label: "Bundled Chat",
          selectionLabel: "Bundled Chat",
          docsPath: "/channels/bundled-chat",
          blurb: "Test",
        },
        install: {
          npmSpec: bundledChatForkNpmSpec,
          expectedIntegrity: bundledChatForkIntegrity,
        },
      },
      prompter,
      runtime,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "npm",
        options: [
          expect.objectContaining({
            value: "npm",
            label: `Download from npm (${bundledChatForkNpmSpec})`,
          }),
          expect.objectContaining({
            value: "skip",
          }),
        ],
      }),
    );
  });

  it("falls back to local path after npm install failure", async () => {
    const runtime = makeRuntime();
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      note,
      confirm,
    });
    const cfg: OpenClawConfig = {};
    mockRepoLocalPathExists();
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      error: "nope",
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    expectPluginLoadedFromLocalPath(result);
    expect(note).toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("clears discovery cache before reloading the setup plugin registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(clearPluginDiscoveryCache).toHaveBeenCalledTimes(1);
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/openclaw-workspace",
        cache: false,
        includeSetupOnlyChannelPlugins: true,
      }),
    );
    expect(clearPluginDiscoveryCache.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loadOpenClawPlugins).mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("loads the setup plugin registry from the auto-enabled config snapshot", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {},
      channels: { "external-chat": { enabled: true } } as never,
    };
    const autoEnabledConfig = {
      ...cfg,
      plugins: {
        entries: {
          "external-chat": { enabled: true },
        },
      },
    } as OpenClawConfig;
    applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {},
    });

    reloadChannelSetupPluginRegistry({
      cfg,
      runtime,
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
      }),
    );
  });

  it("scopes channel reloads when setup starts from an empty registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@vendor/external-chat-plugin" });

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/openclaw-workspace",
        cache: false,
        onlyPluginIds: ["@vendor/external-chat-plugin"],
        includeSetupOnlyChannelPlugins: true,
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("keeps full reloads when the active plugin registry is already populated", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "loaded",
        name: "loaded",
        source: "/tmp/loaded.cjs",
        origin: "bundled",
        configSchema: true,
      }),
    );
    setActivePluginRegistry(registry);

    reloadChannelSetupPluginRegistryForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes channel reloads when the global registry is populated but the pinned channel registry is empty", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@vendor/external-chat-plugin" });
    const activeRegistry = createEmptyPluginRegistry();
    activeRegistry.plugins.push(
      createPluginRecord({
        id: "loaded-tools",
        name: "loaded-tools",
        source: "/tmp/loaded-tools.cjs",
        origin: "bundled",
      }),
    );
    setActivePluginRegistry(activeRegistry);
    const pinnedChannelRegistry = createEmptyPluginRegistry();
    pinActivePluginChannelRegistry(pinnedChannelRegistry);

    try {
      reloadChannelSetupPluginRegistryForChannel({
        cfg,
        runtime,
        channel: "external-chat",
        workspaceDir: "/tmp/openclaw-workspace",
      });
    } finally {
      releasePinnedPluginChannelRegistry(pinnedChannelRegistry);
    }

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        onlyPluginIds: ["@vendor/external-chat-plugin"],
      }),
    );
  });

  it("can load a channel-scoped snapshot without activating the global registry", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry.mockReturnValue({ pluginId: "@vendor/external-chat-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/openclaw-workspace",
        cache: false,
        onlyPluginIds: ["@vendor/external-chat-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledWith("external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
  });

  it("falls back to the bundled plugin for untrusted workspace shadows", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    getChannelPluginCatalogEntry
      .mockReturnValueOnce({ pluginId: "evil-external-chat-shadow", origin: "workspace" })
      .mockReturnValueOnce({ pluginId: "@vendor/external-chat-plugin", origin: "bundled" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["@vendor/external-chat-plugin"],
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
      excludeWorkspace: true,
    });
  });

  it("keeps trusted workspace overrides scoped during setup reloads", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["trusted-external-chat-shadow"],
      },
    };
    getChannelPluginCatalogEntry.mockReturnValue({
      pluginId: "trusted-external-chat-shadow",
      origin: "workspace",
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["trusted-external-chat-shadow"],
      }),
    );
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(1);
  });

  it("does not scope by raw channel id when no trusted plugin mapping exists", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.not.objectContaining({
        onlyPluginIds: expect.anything(),
      }),
    );
  });

  it("scopes snapshots by a unique discovered manifest match when catalog mapping is missing", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        createManifestRecord({
          id: "custom-external-chat-plugin",
          channels: ["external-chat"],
        }),
      ],
      diagnostics: [],
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/openclaw-workspace",
        cache: false,
        onlyPluginIds: ["custom-external-chat-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
  });

  it("scopes snapshots by activation-declared channel ownership when direct channel lists are empty", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    mockActivationOnlyPlugin({ id: "custom-external-chat-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["custom-external-chat-plugin"],
      }),
    );
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        cache: false,
      }),
    );
  });

  it("uses uncached manifest discovery for activation-declared setup scoping", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    mockActivationOnlyPlugin({ id: "custom-external-chat-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadPluginManifestRegistry).toHaveBeenCalled();
    expect(
      loadPluginManifestRegistry.mock.calls.every(
        ([params]) => (params as { cache?: boolean }).cache === false,
      ),
    ).toBe(true);
  });

  it("does not trust unconfigured workspace activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    mockActivationOnlyPlugin({
      id: "evil-external-chat-shadow",
      origin: "workspace",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "evil-external-chat-shadow",
    });
  });

  it("does not trust allowlist-excluded bundled activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        allow: ["other-plugin"],
      },
    };
    mockActivationOnlyPlugin({
      id: "custom-external-chat-plugin",
      origin: "bundled",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "custom-external-chat-plugin",
    });
  });

  it("does not trust explicitly denied bundled activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        deny: ["custom-external-chat-plugin"],
      },
    };
    mockActivationOnlyPlugin({
      id: "custom-external-chat-plugin",
      origin: "bundled",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "custom-external-chat-plugin",
    });
  });

  it("does not trust explicitly disabled workspace activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        enabled: true,
        allow: ["evil-external-chat-shadow"],
        entries: {
          "evil-external-chat-shadow": { enabled: false },
        },
      },
    };
    mockActivationOnlyPlugin({
      id: "evil-external-chat-shadow",
      origin: "workspace",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "evil-external-chat-shadow",
    });
  });

  it("does not trust explicitly disabled bundled activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          "custom-external-chat-plugin": { enabled: false },
        },
      },
    };
    mockActivationOnlyPlugin({
      id: "custom-external-chat-plugin",
      origin: "bundled",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "custom-external-chat-plugin",
    });
  });

  it("does not trust unenabled global activation-only channel ownership during setup", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    mockActivationOnlyPlugin({
      id: "custom-external-chat-global",
      origin: "global",
    });

    expectSetupSnapshotDoesNotScopeToPlugin({
      cfg,
      runtime,
      pluginId: "custom-external-chat-global",
    });
  });

  it("scopes snapshots by plugin id when channel and plugin ids differ", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      pluginId: "@vendor/external-chat-plugin",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: cfg,
        activationSourceConfig: cfg,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/openclaw-workspace",
        cache: false,
        onlyPluginIds: ["@vendor/external-chat-plugin"],
        includeSetupOnlyChannelPlugins: true,
        activate: false,
      }),
    );
  });
});
