// Channel setup plugin install tests cover install decisions, registry reloads, scoped snapshots, and trust boundaries.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createRequireRecord, bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";

const installPluginFromNpmSpec = vi.fn();
const resolveNpmSpecMetadata = vi.hoisted(() => vi.fn());
vi.mock("../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata,
}));
const applyPluginAutoEnable = vi.fn();
vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: (params: Parameters<typeof invokePluginArtifactInstallMock>[1]) =>
    invokePluginArtifactInstallMock(installPluginFromNpmSpec, params),
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
    listRawChannelPluginCatalogEntries: (...args: unknown[]) =>
      listChannelPluginCatalogEntries(...args),
  };
});

const loadPluginManifestRegistryCore = vi.fn();
vi.mock("../../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistryCore: (
      params: Parameters<typeof actual.loadPluginManifestRegistryCore>[0],
    ) =>
      // Artifact consent reads real fixtures; setup inventory remains independently mocked.
      params?.discovery
        ? actual.loadPluginManifestRegistryCore(params)
        : loadPluginManifestRegistryCore(params),
  };
});

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

vi.mock("../../plugins/loader.js", () => {
  const load = vi.fn();
  return { loadOpenClawPlugins: load, loadPluginRegistryHandle: load };
});

const discoverOpenClawPlugins = vi.fn((_args?: unknown) => ({
  candidates: [] as PluginCandidate[],
  diagnostics: [],
}));
vi.mock("../../plugins/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/discovery.js")>()),
  discoverOpenClawPlugins: (args: unknown) => discoverOpenClawPlugins(args),
}));

import type { ChannelPluginCatalogEntry } from "../../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginCandidate } from "../../plugins/discovery.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../../plugins/install-types.js";
import { loadOpenClawPlugins } from "../../plugins/loader.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { makePrompter, makeRuntime } from "../setup/__tests__/test-utils.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./plugin-install.js";

const bundledChatNpmSpec = "@openclaw/bundled-chat@1.2.3";
const bundledChatIntegrity = "sha512-bundled-chat";
const bundledChatForkNpmSpec = "@vendor/bundled-chat-fork@1.2.3";
const bundledChatForkIntegrity = "sha512-vendor-bundled-chat-fork";
const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
  const { localPath } = createLocalPluginFixture();
  resolveBundledPluginSources.mockReturnValue(
    new Map([
      [
        "bundled-chat",
        {
          pluginId: "bundled-chat",
          localPath,
          npmSpec: bundledChatNpmSpec,
        },
      ],
    ]),
  );
  return localPath;
}

function makeSkipInstallPrompter(acceptCapabilities = false) {
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const confirm = vi.fn(async () => acceptCapabilities);
  const prompter = makePrompter({ select: select as WizardPrompter["select"], confirm });
  return { prompter, select, confirm };
}

function mockActivationOnlyPlugin(plugin: {
  id: string;
  origin?: "bundled" | "global" | "workspace";
}) {
  loadPluginManifestRegistryCore.mockReturnValue({
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

  expect(loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  expect(requireMockCallArg(vi.mocked(loadOpenClawPlugins), 0).onlyPluginIds).toStrictEqual([]);
}

beforeEach(() => {
  resolveNpmSpecMetadata.mockReset().mockRejectedValue(new Error("Unseeded npm metadata query"));
  clearPluginMetadataLifecycleCaches();
  vi.clearAllMocks();
  applyPluginAutoEnable.mockImplementation((params: { config: unknown }) => ({
    config: params.config,
    changes: [],
    autoEnabledReasons: {},
  }));
  resolveBundledPluginSources.mockReturnValue(new Map());
  discoverOpenClawPlugins.mockReturnValue({ candidates: [], diagnostics: [] });
  getChannelPluginCatalogEntry.mockReturnValue(undefined);
  listChannelPluginCatalogEntries.mockReturnValue([]);
  loadPluginManifestRegistryCore.mockReturnValue({ plugins: [], diagnostics: [] });
  setActivePluginRegistry(createEmptyPluginRegistry());
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  if (ORIGINAL_OPENCLAW_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
  }
});

function createLocalPluginFixture(pluginId = "bundled-chat") {
  const workspaceDir = tempDirs.make("openclaw-channel-plugin-");
  const localPath = path.join(workspaceDir, bundledPluginRoot("bundled-chat"));
  fs.mkdirSync(path.join(workspaceDir, ".git"));
  fs.mkdirSync(localPath, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir: localPath,
    pluginId,
  });
  return { workspaceDir, localPath, runtimeMarker: fixture.runtimeMarker };
}

async function runInitialValueForChannel(channel: "dev" | "beta") {
  const runtime = makeRuntime();
  const select = vi.fn((async <T extends string>() => "skip" as T) as WizardPrompter["select"]);
  const prompter = makePrompter({ select: select as unknown as WizardPrompter["select"] });
  const cfg: OpenClawConfig = { update: { channel } };
  const { workspaceDir } = createLocalPluginFixture();

  await ensureChannelSetupPluginInstalled({
    cfg,
    entry: baseEntry,
    prompter,
    runtime,
    workspaceDir,
  });

  return requireMockCallArg(select, 0).initialValue;
}

function expectPluginLoadedFromLocalPath(
  result: Awaited<ReturnType<typeof ensureChannelSetupPluginInstalled>>,
  expectedPath: string,
) {
  expect(result.installed).toBe(true);
  expect(result.cfg.plugins?.load?.paths).toContain(expectedPath);
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function requireMockCallArg(mock: MockWithCalls, callIndex: number, argIndex = 0) {
  return requireRecord(mock.mock.calls[callIndex]?.[argIndex], "mock call argument");
}

function requireSelectOptions(select: MockWithCalls) {
  return requireArray(requireMockCallArg(select, 0).options, "select options");
}

function requireOptionByValue(options: unknown[], value: string) {
  const option = options.find(
    (candidate) => requireRecord(candidate, "select option").value === value,
  );
  return requireRecord(option, `select option ${value}`);
}

function expectLoadOpenClawPluginFields(expected: Record<string, unknown>, callIndex = 0) {
  expectRecordFields(
    requireMockCallArg(vi.mocked(loadOpenClawPlugins), callIndex),
    "loadOpenClawPlugins args",
    expected,
  );
}

describe("ensureChannelSetupPluginInstalled", () => {
  it("installs from npm and enables the plugin", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      confirm: vi.fn(async () => true),
    });
    const cfg: OpenClawConfig = { plugins: { allow: ["bundled-chat"] } };
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
    expectRecordFields(result.cfg.plugins?.installs?.["bundled-chat"], "plugin install record", {
      source: "npm",
      spec: bundledChatNpmSpec,
      installPath: "/tmp/bundled-chat",
    });
    expectRecordFields(requireMockCallArg(installPluginFromNpmSpec, 0), "npm install args", {
      expectedIntegrity: bundledChatIntegrity,
      spec: bundledChatNpmSpec,
    });
  });

  it("installs npm channel plugins into the active profile extensions dir", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      confirm: vi.fn(async () => true),
    });
    const profileStateDir = tempDirs.make("openclaw-ledger-channel-");
    process.env.OPENCLAW_STATE_DIR = profileStateDir;
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

    expectRecordFields(requireMockCallArg(installPluginFromNpmSpec, 0), "npm install args", {
      extensionsDir: path.resolve(profileStateDir, "extensions"),
      spec: bundledChatNpmSpec,
    });
  });

  it("uses local path when selected", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
      confirm: vi.fn(async () => true),
    });
    const cfg: OpenClawConfig = {};
    const { workspaceDir, localPath, runtimeMarker } = createLocalPluginFixture();

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
      workspaceDir,
    });

    expectPluginLoadedFromLocalPath(result, localPath);
    expect(result.cfg.plugins?.entries?.["bundled-chat"]?.enabled).toBe(true);
    expect(result.cfg.plugins?.installs?.["bundled-chat"]?.acceptedSurface).toBeDefined();
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("uses the catalog plugin id for local-path installs", async () => {
    const runtime = makeRuntime();
    const prompter = makePrompter({
      select: vi.fn(async () => "local") as WizardPrompter["select"],
      confirm: vi.fn(async () => true),
    });
    const cfg: OpenClawConfig = {};
    const { workspaceDir } = createLocalPluginFixture("@vendor/external-chat-plugin");

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        ...baseEntry,
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
      },
      prompter,
      runtime,
      workspaceDir,
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

  it.each([
    { beta: "2026.5.4-beta.1", latest: "2026.5.4", selected: "2026.5.4" },
    { beta: "2026.5.5-beta.1", latest: "2026.5.4", selected: "2026.5.5-beta.1" },
  ])(
    "installs $selected on beta while preserving npm intent",
    async ({ beta, latest, selected }) => {
      const runtime = makeRuntime();
      const { prompter, select } = makeSkipInstallPrompter(true);
      const cfg: OpenClawConfig = { update: { channel: "beta" } };
      resolveNpmSpecMetadata.mockImplementation(async ({ spec }: { spec: string }) => {
        const version = spec === "@openclaw/wecom@beta" ? beta : latest;
        expect(["@openclaw/wecom@beta", "@openclaw/wecom@latest"]).toContain(spec);
        const name = "@openclaw/wecom";
        const metadata = { name, version, resolvedSpec: `${name}@${version}` };
        return { ok: true, metadata };
      });
      installPluginFromNpmSpec.mockResolvedValue({
        ok: true,
        pluginId: "wecom-openclaw-plugin",
        targetDir: "/tmp/wecom-openclaw-plugin",
        version: selected,
        npmResolution: {
          name: "@openclaw/wecom",
          version: selected,
          resolvedSpec: `@openclaw/wecom@${selected}`,
        },
      });

      const result = await ensureChannelSetupPluginInstalled({
        cfg,
        entry: {
          id: "wecom",
          pluginId: "wecom-openclaw-plugin",
          meta: {
            id: "wecom",
            label: "WeCom",
            selectionLabel: "WeCom",
            docsPath: "/channels/wecom",
            blurb: "WeCom channel",
          },
          install: {
            npmSpec: "@openclaw/wecom",
          },
        },
        prompter,
        runtime,
        promptInstall: false,
      });

      expect(select).not.toHaveBeenCalled();
      expectRecordFields(requireMockCallArg(installPluginFromNpmSpec, 0), "npm install args", {
        spec: `@openclaw/wecom@${selected}`,
        expectedPluginId: "wecom-openclaw-plugin",
      });
      expect(result.cfg.plugins?.installs?.["wecom-openclaw-plugin"]?.spec).toBe("@openclaw/wecom");
    },
  );

  it("defaults to bundled local path on beta channel when available", async () => {
    const runtime = makeRuntime();
    const { prompter, select } = makeSkipInstallPrompter();
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    const localPath = mockBundledChatSource();

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
    });

    const selectArgs = requireMockCallArg(select, 0);
    expect(selectArgs.initialValue).toBe("local");
    expectRecordFields(
      requireOptionByValue(requireSelectOptions(select), "local"),
      "local option",
      {
        value: "local",
        hint: localPath,
      },
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

    const selectArgs = requireMockCallArg(select, 0);
    expect(selectArgs.initialValue).toBe("npm");
    const options = requireSelectOptions(select);
    expect(options).toHaveLength(2);
    expectRecordFields(options[0], "npm option", {
      value: "npm",
      label: `Download from npm (${bundledChatForkNpmSpec})`,
    });
    expectRecordFields(options[1], "skip option", {
      value: "skip",
    });
  });

  it("offers ClawHub as the first-class install source for channel catalog entries", async () => {
    const runtime = makeRuntime();
    const { prompter, select } = makeSkipInstallPrompter();
    const cfg: OpenClawConfig = { update: { channel: "beta" } };
    resolveBundledPluginSources.mockReturnValue(new Map());

    await ensureChannelSetupPluginInstalled({
      cfg,
      entry: {
        id: "clawhub-chat",
        pluginId: "clawhub-chat",
        meta: {
          id: "clawhub-chat",
          label: "ClawHub Chat",
          selectionLabel: "ClawHub Chat",
          docsPath: "/channels/clawhub-chat",
          blurb: "Test",
        },
        install: {
          clawhubSpec: "clawhub:openclaw/clawhub-chat@2026.5.2",
          defaultChoice: "clawhub",
        },
      },
      prompter,
      runtime,
    });

    const selectArgs = requireMockCallArg(select, 0);
    expect(selectArgs.initialValue).toBe("clawhub");
    const options = requireSelectOptions(select);
    expect(options).toHaveLength(2);
    expectRecordFields(options[0], "clawhub option", {
      value: "clawhub",
      label: "Download from ClawHub (clawhub:openclaw/clawhub-chat@2026.5.2)",
    });
    expectRecordFields(options[1], "skip option", {
      value: "skip",
    });
  });

  it.each([
    {
      scenario: "falls back to local path when the npm target is not published",
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
      error: "Package not found on npm: @openclaw/bundled-chat@1.2.3",
      fallback: true,
    },
    {
      scenario: "refuses local fallback for an untyped npm error mentioning E404",
      code: undefined,
      error: "E404 while installing a dependency",
      fallback: false,
    },
    {
      scenario: "refuses local fallback after an npm integrity failure",
      code: undefined,
      error: "aborted: npm package integrity drift",
      fallback: false,
    },
    {
      scenario: "refuses local fallback after an npm policy failure",
      code: PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED,
      error: "Plugin install blocked by policy",
      fallback: false,
    },
  ])("$scenario", async ({ code, error, fallback }) => {
    const runtime = makeRuntime();
    const note = vi.fn(async () => {});
    const confirm = vi.fn(async () => true);
    const prompter = makePrompter({
      select: vi.fn(async () => "npm") as WizardPrompter["select"],
      note,
      confirm,
    });
    const cfg: OpenClawConfig = {};
    const { workspaceDir, localPath } = createLocalPluginFixture();
    installPluginFromNpmSpec.mockResolvedValue({
      ok: false,
      code,
      error,
    });

    const result = await ensureChannelSetupPluginInstalled({
      cfg,
      entry: baseEntry,
      prompter,
      runtime,
      workspaceDir,
    });

    expect(note).toHaveBeenCalled();
    expect(installPluginFromNpmSpec).toHaveBeenCalledOnce();
    if (fallback) {
      expectPluginLoadedFromLocalPath(result, localPath);
      expect(result.cfg.plugins?.installs?.["bundled-chat"]?.acceptedSurface).toBeDefined();
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      expect(result).toEqual({ cfg, installed: false, pluginId: "bundled-chat", status: "failed" });
      expect(confirm).not.toHaveBeenCalled();
      expect(runtime.error).toHaveBeenCalledWith(`Plugin install failed: ${error}`);
    }
  });

  it.each([true, false])(
    "auto-selects the only npm source but requires capability consent, accepted=%s",
    async (acceptCapabilities) => {
      const runtime = makeRuntime();
      const { prompter, select, confirm } = makeSkipInstallPrompter(acceptCapabilities);
      const cfg: OpenClawConfig = {};
      // npm-only entry (no local path)
      const npmOnlyEntry: ChannelPluginCatalogEntry = {
        id: "wecom",
        pluginId: "wecom-openclaw-plugin",
        meta: {
          id: "wecom",
          label: "WeCom",
          selectionLabel: "WeCom",
          docsPath: "/channels/wecom",
          blurb: "WeCom channel",
        },
        install: {
          npmSpec: "@openclaw/wecom@2026.4.23",
        },
      };
      installPluginFromNpmSpec.mockResolvedValue({
        ok: true,
        pluginId: "wecom-openclaw-plugin",
        targetDir: "/tmp/wecom-openclaw-plugin",
      });
      resolveBundledPluginSources.mockReturnValue(new Map());

      const result = await ensureChannelSetupPluginInstalled({
        cfg,
        entry: npmOnlyEntry,
        prompter,
        runtime,
        autoConfirmSingleSource: true,
      });

      expect(select).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledOnce();
      expect(result.installed).toBe(acceptCapabilities);
      expect(result.pluginId).toBe("wecom-openclaw-plugin");
      if (!acceptCapabilities) {
        expect(result.cfg).toBe(cfg);
        expect(runtime.error).toHaveBeenCalledWith(expect.stringMatching(/capabilit/i));
      }
    },
  );

  it("loads setup snapshots from the auto-enabled config snapshot", () => {
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

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(applyPluginAutoEnable).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expectLoadOpenClawPluginFields({
      config: autoEnabledConfig,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
    });
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

    expectLoadOpenClawPluginFields({
      config: cfg,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/openclaw-workspace",
      cache: false,
      onlyPluginIds: ["@vendor/external-chat-plugin"],
      includeSetupOnlyChannelPlugins: true,
      channelPluginLoadIntent: "setup",
    });
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

    expectLoadOpenClawPluginFields({
      onlyPluginIds: ["@vendor/external-chat-plugin"],
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(1, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenNthCalledWith(2, "external-chat", {
      workspaceDir: "/tmp/openclaw-workspace",
      env: undefined,
      excludePluginRefs: [{ pluginId: "evil-external-chat-shadow", origin: "workspace" }],
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

    expectLoadOpenClawPluginFields({
      onlyPluginIds: ["trusted-external-chat-shadow"],
    });
    expect(getChannelPluginCatalogEntry).toHaveBeenCalledTimes(1);
  });

  it("does not widen setup snapshots when no trusted plugin mapping exists", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expectLoadOpenClawPluginFields({
      onlyPluginIds: [],
    });
  });

  it("scopes snapshots by a unique discovered manifest match when catalog mapping is missing", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    loadPluginManifestRegistryCore.mockReturnValue({
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

    expectLoadOpenClawPluginFields({
      config: cfg,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/openclaw-workspace",
      cache: false,
      onlyPluginIds: ["custom-external-chat-plugin"],
      includeSetupOnlyChannelPlugins: true,
      channelPluginLoadIntent: "setup",
    });
  });

  it("scopes snapshots by activation-declared channel ownership when direct channel lists are empty", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    let sawTrustedCandidate = false;
    discoverOpenClawPlugins.mockReturnValue({
      candidates: [
        {
          idHint: "custom-external-chat-plugin",
          source: "/tmp/openclaw-test/custom-external-chat-plugin/index.ts",
          rootDir: "/tmp/openclaw-test/custom-external-chat-plugin",
          origin: "bundled",
        },
      ],
      diagnostics: [],
    });
    loadPluginManifestRegistryCore.mockImplementation((args: unknown) => {
      if (
        isRecord(args) &&
        args.config === cfg &&
        args.workspaceDir === "/tmp/openclaw-workspace" &&
        Array.isArray(args.candidates)
      ) {
        sawTrustedCandidate ||= args.candidates.some((candidate) => {
          const record = isRecord(candidate) ? candidate : {};
          return record.idHint === "custom-external-chat-plugin" && record.origin === "bundled";
        });
      }
      return {
        plugins: [
          createManifestRecord({
            id: "custom-external-chat-plugin",
            activation: {
              onChannels: ["external-chat"],
            },
          }),
        ],
        diagnostics: [],
      };
    });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expectLoadOpenClawPluginFields({
      onlyPluginIds: ["custom-external-chat-plugin"],
    });
    expect(sawTrustedCandidate).toBe(true);
  });

  it("uses live manifest discovery for activation-declared setup scoping", () => {
    const runtime = makeRuntime();
    const cfg: OpenClawConfig = {};
    mockActivationOnlyPlugin({ id: "custom-external-chat-plugin" });

    loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg,
      runtime,
      channel: "external-chat",
      workspaceDir: "/tmp/openclaw-workspace",
    });

    expect(loadPluginManifestRegistryCore).toHaveBeenCalled();
    expect(
      loadPluginManifestRegistryCore.mock.calls.every(
        ([params]) => !Object.hasOwn(params ?? {}, "cache"),
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

    expectLoadOpenClawPluginFields({
      config: cfg,
      activationSourceConfig: cfg,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/openclaw-workspace",
      cache: false,
      onlyPluginIds: ["@vendor/external-chat-plugin"],
      includeSetupOnlyChannelPlugins: true,
      channelPluginLoadIntent: "setup",
    });
  });
});
