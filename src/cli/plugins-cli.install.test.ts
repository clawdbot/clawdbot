// Plugins CLI install tests cover plugin install command selection and output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installedPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { hashConfigIncludeRaw } from "../config/includes.js";
import { recordPluginManifestInstallOwner } from "../plugins/manifest-install-owner.js";
import {
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
} from "../plugins/official-external-plugin-catalog.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  applyExclusiveSlotSelectionMock,
  buildPluginSnapshotReportMock,
  clearPluginRegistryLoadCacheMock,
  enablePluginInConfigMock,
  findBundledPluginSourceMock,
  installHooksFromNpmSpecMock,
  installHooksFromPathMock,
  installPluginFromNpmPackArchiveMock,
  installPluginFromClawHubMock,
  installPluginFromGitSpecMock,
  installPluginFromMarketplaceMock,
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  pluginCliConfigMock,
  loadPluginManifestRegistryMock,
  readConfigFileSnapshotMock,
  readConfigFileSnapshotForWriteMock,
  parseClawHubPluginSpecMock,
  promptYesNoMock,
  reportClawHubPluginInstallTelemetryMock,
  recordHookInstallMock,
  recordPluginInstallMock,
  resetPluginsCliTestState,
  replaceConfigFileMock,
  runPluginsCommand,
  runtimeErrors,
  pluginsCliRuntimeLogs,
  configWriteMock,
  writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
} from "./plugins-cli-test-helpers.js";

// Default-selector assertions describe a stable build; beta cases set their own identity.
const coreVersion = vi.hoisted(() => ({ value: "2026.8.1" }));
vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  get VERSION() {
    return coreVersion.value;
  },
}));

const CLI_STATE_ROOT = "/tmp/openclaw-state";
const ORIGINAL_OPENCLAW_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const ORIGINAL_OPENCLAW_NIX_MODE = process.env.OPENCLAW_NIX_MODE;
const ORIGINAL_STDIN_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const ORIGINAL_STDOUT_TTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const PROFILE_STATE_ROOT = "/tmp/openclaw-ledger-profile";

const OFFICIAL_EXTERNAL_NPM_INSTALLS_WITHOUT_INTEGRITY = listOfficialExternalPluginCatalogEntries()
  .map((entry) => {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const install = resolveOfficialExternalPluginInstall(entry);
    const npmSpec = install?.npmSpec?.trim();
    if (!pluginId || !npmSpec || install?.expectedIntegrity) {
      return null;
    }
    return { pluginId, npmSpec };
  })
  .filter((entry): entry is { pluginId: string; npmSpec: string } => Boolean(entry))
  .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

function cliInstallPath(pluginId: string): string {
  return installedPluginRoot(CLI_STATE_ROOT, pluginId);
}

function useProfileExtensionsDir(): string {
  process.env.OPENCLAW_STATE_DIR = PROFILE_STATE_ROOT;
  return path.resolve(PROFILE_STATE_ROOT, "extensions");
}

function createEnabledPluginConfig(pluginId: string): OpenClawConfig {
  return {
    plugins: {
      entries: {
        [pluginId]: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function createEmptyPluginConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {},
    },
  } as OpenClawConfig;
}

function createClawHubInstallResult(params: {
  pluginId: string;
  packageName: string;
  version: string;
  channel: string;
  trust?: {
    disposition: "clean" | "review-recommended" | "review-required";
    scanStatus?: string;
    moderationState?: string;
    reasons?: string[];
    pending?: boolean;
    stale?: boolean;
    checkedAt?: string;
    acknowledgedAt?: string;
  };
}): Awaited<ReturnType<typeof installPluginFromClawHubMock>> {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: cliInstallPath(params.pluginId),
    version: params.version,
    packageName: params.packageName,
    clawhub: {
      source: "clawhub",
      clawhubUrl: "https://clawhub.ai",
      clawhubPackage: params.packageName,
      clawhubFamily: "code-plugin",
      clawhubChannel: params.channel,
      version: params.version,
      integrity: "sha256-abc",
      resolvedAt: "2026-03-22T00:00:00.000Z",
      clawpackSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      clawpackSpecVersion: 1,
      clawpackManifestSha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      clawpackSize: 4096,
      ...(params.trust
        ? {
            clawhubTrustDisposition: params.trust.disposition,
            ...(params.trust.scanStatus ? { clawhubTrustScanStatus: params.trust.scanStatus } : {}),
            ...(params.trust.moderationState
              ? { clawhubTrustModerationState: params.trust.moderationState }
              : {}),
            ...(params.trust.reasons ? { clawhubTrustReasons: params.trust.reasons } : {}),
            ...(params.trust.pending ? { clawhubTrustPending: true } : {}),
            ...(params.trust.stale ? { clawhubTrustStale: true } : {}),
            ...(params.trust.checkedAt ? { clawhubTrustCheckedAt: params.trust.checkedAt } : {}),
            ...(params.trust.acknowledgedAt
              ? { clawhubTrustAcknowledgedAt: params.trust.acknowledgedAt }
              : {}),
          }
        : {}),
    },
  };
}

function createNpmPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmSpecMock>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    npmResolution: {
      packageName: pluginId,
      resolvedVersion: "1.2.3",
      tarballUrl: `https://registry.npmjs.org/${pluginId}/-/${pluginId}-1.2.3.tgz`,
    },
  };
}

function createNpmPackPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromNpmPackArchiveMock>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    extensions: ["dist/index.js"],
    manifestName: `@openclaw/${pluginId}`,
    npmTarballName: `openclaw-${pluginId}-1.2.3.tgz`,
    npmResolution: {
      name: `@openclaw/${pluginId}`,
      version: "1.2.3",
      resolvedSpec: `@openclaw/${pluginId}@1.2.3`,
      integrity: "sha512-pack-demo",
      shasum: "packdemosha",
      resolvedAt: "2026-05-06T00:00:00.000Z",
    },
  };
}

function createGitPluginInstallResult(
  pluginId = "demo",
): Awaited<ReturnType<typeof installPluginFromGitSpecMock>> {
  return {
    ok: true,
    pluginId,
    targetDir: cliInstallPath(pluginId),
    version: "1.2.3",
    extensions: ["index.js"],
    git: {
      url: "https://github.com/acme/demo.git",
      ref: "v1.2.3",
      commit: "abc123",
      resolvedAt: "2026-04-30T00:00:00.000Z",
    },
  };
}

function mockClawHubPackageNotFound(packageName: string) {
  installPluginFromClawHubMock.mockResolvedValue({
    ok: false,
    error: `ClawHub /api/v1/packages/${packageName} failed (404): Package not found`,
    code: "package_not_found",
  });
}

function primeNpmPluginFallback(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  pluginCliConfigMock.mockReturnValue(cfg);
  mockClawHubPackageNotFound(pluginId);
  installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult(pluginId));
  enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
  recordPluginInstallMock.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelectionMock.mockReturnValue({
    config: enabledCfg,
    warnings: [],
  });

  return { cfg, enabledCfg };
}

function primeSuccessfulPluginPersistence(pluginId = "demo") {
  const cfg = createEmptyPluginConfig();
  const enabledCfg = createEnabledPluginConfig(pluginId);

  pluginCliConfigMock.mockReturnValue(cfg);
  enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
  recordPluginInstallMock.mockReturnValue(enabledCfg);
  applyExclusiveSlotSelectionMock.mockReturnValue({
    config: enabledCfg,
    warnings: [],
  });

  return { cfg, enabledCfg };
}

function primeSuccessfulClawHubPluginInstall(
  params: {
    explicitVersion?: boolean;
    trust?: Parameters<typeof createClawHubInstallResult>[0]["trust"];
  } = {},
) {
  const result = primeSuccessfulPluginPersistence("demo");
  parseClawHubPluginSpecMock.mockReturnValue({
    name: "demo",
    ...(params.explicitVersion ? { version: "1.2.3" } : {}),
  });
  installPluginFromClawHubMock.mockResolvedValue(
    createClawHubInstallResult({
      pluginId: "demo",
      packageName: "demo",
      version: "1.2.3",
      channel: "official",
      ...(params.trust ? { trust: params.trust } : {}),
    }),
  );
  return result;
}

function createPathHookPackInstalledConfig(tmpRoot: string): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "path",
            sourcePath: tmpRoot,
            installPath: tmpRoot,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createNpmHookPackInstalledConfig(): OpenClawConfig {
  return {
    hooks: {
      internal: {
        installs: {
          "demo-hooks": {
            source: "npm",
            spec: "@acme/demo-hooks@1.2.3",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createHookPackInstallResult(targetDir: string): {
  ok: true;
  hookPackId: string;
  hooks: string[];
  packageKind: "hook-only";
  targetDir: string;
  version: string;
} {
  return {
    ok: true,
    hookPackId: "demo-hooks",
    hooks: ["command-audit"],
    packageKind: "hook-only",
    targetDir,
    version: "1.2.3",
  };
}

function primeHookPackNpmFallback() {
  const cfg = {} as OpenClawConfig;
  const installedCfg = createNpmHookPackInstalledConfig();

  pluginCliConfigMock.mockReturnValue(cfg);
  mockClawHubPackageNotFound("@acme/demo-hooks");
  installPluginFromNpmSpecMock.mockResolvedValue({
    ok: false,
    error: "package.json missing openclaw.plugin.json",
  });
  installHooksFromNpmSpecMock.mockResolvedValue({
    ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
    npmResolution: {
      name: "@acme/demo-hooks",
      version: "1.2.3",
      resolvedSpec: "@acme/demo-hooks@1.2.3",
      integrity: "sha256-demo",
    },
  });
  recordHookInstallMock.mockReturnValue(installedCfg);

  return { cfg, installedCfg };
}

function primeHookPackPathFallback(params: {
  tmpRoot: string;
  pluginInstallError: string;
}): OpenClawConfig {
  const installedCfg = createPathHookPackInstalledConfig(params.tmpRoot);

  pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
  installPluginFromPathMock.mockResolvedValueOnce({
    ok: false,
    error: params.pluginInstallError,
  });
  installHooksFromPathMock.mockResolvedValueOnce(createHookPackInstallResult(params.tmpRoot));
  recordHookInstallMock.mockReturnValue(installedCfg);

  return installedCfg;
}

type MockWithCalls = {
  mock: {
    calls: readonly (readonly unknown[])[];
  };
};

type PluginInstallCall = {
  allowSourceTypeScriptEntries?: boolean;
  archivePath?: string;
  confirmInstall?: () => boolean | Promise<boolean>;
  dangerouslyForceUnsafeInstall?: boolean;
  dryRun?: boolean;
  expectedIntegrity?: string;
  expectedPackageKind?: "hook-only";
  expectedPluginId?: string;
  extensionsDir?: string;
  inspection?: "package-kind";
  logger?: {
    info?: unknown;
    warn?: unknown;
  };
  onInstallPolicyWarning?: unknown;
  marketplace?: string;
  mode?: string;
  path?: string;
  plugin?: string;
  spec?: string;
  trustedSourceLinkedOfficialInstall?: boolean;
};

type PersistedInstallRecord = Record<string, unknown>;

function mockCallArg(mock: MockWithCalls, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  if (call.length <= argIndex) {
    throw new Error(`Expected mock call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function marketplaceInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromMarketplaceMock, callIndex) as PluginInstallCall;
}

function clawHubInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromClawHubMock, callIndex) as PluginInstallCall;
}

function npmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromNpmSpecMock, callIndex) as PluginInstallCall;
}

function npmPackInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromNpmPackArchiveMock, callIndex) as PluginInstallCall;
}

function gitInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromGitSpecMock, callIndex) as PluginInstallCall;
}

function pathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installPluginFromPathMock, callIndex) as PluginInstallCall;
}

function hookPathInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromPathMock, callIndex) as PluginInstallCall;
}

function hookNpmInstallCall(callIndex = 0): PluginInstallCall {
  return mockCallArg(installHooksFromNpmSpecMock, callIndex) as PluginInstallCall;
}

function persistedInstallRecords(callIndex = 0): Record<string, PersistedInstallRecord> {
  return mockCallArg(
    writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock,
    callIndex,
  ) as Record<string, PersistedInstallRecord>;
}

function persistedInstallRecord(pluginId: string, callIndex = 0): PersistedInstallRecord {
  const record = persistedInstallRecords(callIndex)[pluginId];
  if (!record) {
    throw new Error(`Expected persisted install record for ${pluginId}`);
  }
  return record;
}

function replaceConfigCall(callIndex = 0): { baseHash?: string; nextConfig?: OpenClawConfig } {
  return mockCallArg(replaceConfigFileMock, callIndex) as {
    baseHash?: string;
    nextConfig?: OpenClawConfig;
  };
}

function recordHookInstallCall(callIndex = 0): PersistedInstallRecord {
  return mockCallArg(recordHookInstallMock, callIndex, 1) as PersistedInstallRecord;
}

function runtimeLogsContain(fragment: string): boolean {
  return pluginsCliRuntimeLogs.some((line) => line.includes(fragment));
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreTty(): void {
  if (ORIGINAL_STDIN_TTY) {
    Object.defineProperty(process.stdin, "isTTY", ORIGINAL_STDIN_TTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
  if (ORIGINAL_STDOUT_TTY) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_STDOUT_TTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

const NON_CLAWHUB_INSTALL_FORCE_FLAG = "--force";

function withNonClawHubInstallAcknowledgement(args: string[]): string[] {
  return [
    ...args,
    ...(args.includes(NON_CLAWHUB_INSTALL_FORCE_FLAG) ? [] : [NON_CLAWHUB_INSTALL_FORCE_FLAG]),
    ...(args.includes("--accept-capabilities") ? [] : ["--accept-capabilities"]),
  ];
}

async function runAcknowledgedPluginsInstallCommand(args: string[]): Promise<void> {
  await runPluginsCommand(withNonClawHubInstallAcknowledgement(args));
}

async function runCapabilityAcceptedPluginsInstallCommand(args: string[]): Promise<void> {
  await runPluginsCommand([...args, "--accept-capabilities"]);
}

function primeInstallConfigSnapshot(params: {
  config?: OpenClawConfig;
  configPath?: string;
  hash: string;
  parsed: Record<string, unknown>;
  includeFileHashesForWrite?: Record<string, string>;
  includeFileTargetsForWrite?: Record<string, string>;
}): void {
  const configPath = params.configPath ?? path.join(process.cwd(), "openclaw.json5");
  const config = params.config ?? ({} as OpenClawConfig);
  pluginCliConfigMock.mockReturnValue(config);
  readConfigFileSnapshotForWriteMock.mockResolvedValue({
    snapshot: {
      path: configPath,
      exists: true,
      raw: JSON.stringify(params.parsed),
      parsed: params.parsed,
      resolved: config,
      sourceConfig: config,
      runtimeConfig: config,
      valid: true,
      config,
      hash: params.hash,
      issues: [],
      warnings: [],
      legacyIssues: [],
    },
    writeOptions: {
      assertConfigPathForWrite: () => {},
      expectedConfigPath: configPath,
      ownedConfigPathForWrite: configPath,
      ...(params.includeFileHashesForWrite
        ? { includeFileHashesForWrite: params.includeFileHashesForWrite }
        : {}),
      ...(params.includeFileTargetsForWrite
        ? { includeFileTargetsForWrite: params.includeFileTargetsForWrite }
        : {}),
    },
  });
}

function primeBlockedPluginConfigMutation(
  params: { blockHooks?: boolean; config?: OpenClawConfig } = {},
): void {
  const externalPluginsPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    "plugins.json5",
  );
  const externalHooksPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    "hooks.json5",
  );
  primeInstallConfigSnapshot({
    config: params.config,
    hash: "blocked-plugin-config",
    parsed: {
      plugins: { $include: externalPluginsPath },
      ...(params.blockHooks ? { hooks: { $include: externalHooksPath } } : {}),
    },
    includeFileTargetsForWrite: {
      [externalPluginsPath]: externalPluginsPath,
      ...(params.blockHooks ? { [externalHooksPath]: externalHooksPath } : {}),
    },
  });
}

function primeNestedPluginConfigMutation(tempRoot: string): void {
  const configPath = path.join(tempRoot, "openclaw.json5");
  const pluginsPath = path.join(tempRoot, "plugins.json5");
  const pluginsRaw = `${JSON.stringify({ entries: { $include: "./entries.json5" } }, null, 2)}\n`;
  const config = { plugins: { entries: {} } } as OpenClawConfig;
  fs.writeFileSync(pluginsPath, pluginsRaw);
  primeInstallConfigSnapshot({
    config,
    configPath,
    hash: "nested-plugin-config",
    parsed: { plugins: { $include: "./plugins.json5" } },
    includeFileHashesForWrite: {
      [pluginsPath]: hashConfigIncludeRaw(pluginsRaw),
    },
    includeFileTargetsForWrite: {
      [pluginsPath]: fs.realpathSync(pluginsPath),
    },
  });
}

function primeBlockedRootConfigMutation(config = {} as OpenClawConfig): void {
  primeInstallConfigSnapshot({
    config,
    hash: "blocked-root-config",
    parsed: { $include: "./shared.json5", plugins: {} },
  });
}

function primeBlockedHookConfigMutation(config = {} as OpenClawConfig): void {
  const externalHooksPath = path.join(
    path.parse(process.cwd()).root,
    "external-openclaw",
    "hooks.json5",
  );
  primeInstallConfigSnapshot({
    config,
    hash: "blocked-hook-config",
    parsed: { hooks: { $include: externalHooksPath } },
    includeFileTargetsForWrite: {
      [externalHooksPath]: externalHooksPath,
    },
  });
}

describe("plugins cli install", () => {
  beforeEach(() => {
    resetPluginsCliTestState();
  });

  afterEach(() => {
    coreVersion.value = "2026.8.1";
    if (ORIGINAL_OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_OPENCLAW_STATE_DIR;
    }
    if (ORIGINAL_OPENCLAW_NIX_MODE === undefined) {
      delete process.env.OPENCLAW_NIX_MODE;
    } else {
      process.env.OPENCLAW_NIX_MODE = ORIGINAL_OPENCLAW_NIX_MODE;
    }
    restoreTty();
  });

  it("shows one force option for confirmation and overwrite", async () => {
    const { Command } = await import("commander");
    const { registerPluginsCli } = await import("./plugins-cli.js");
    const program = new Command();
    registerPluginsCli(program);

    const pluginsCommand = program.commands.find((command) => command.name() === "plugins");
    const installCommand = pluginsCommand?.commands.find((command) => command.name() === "install");
    const helpText = installCommand?.helpInformation() ?? "";

    expect(helpText.match(/--force/g)).toHaveLength(1);
    expect(helpText).toContain("--accept-capabilities");
    expect(helpText).toMatch(/Confirm non-ClawHub sources and\s+overwrite/u);
    expect(helpText).toMatch(/an existing plugin or hook\s+pack/u);
  });

  it("refuses plugin installs in Nix mode before installer side effects", async () => {
    process.env.OPENCLAW_NIX_MODE = "1";

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo"]),
    ).rejects.toThrow("OPENCLAW_NIX_MODE=1");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it.each(["@acme/demo-plugin", "npm:@acme/demo-plugin"])(
    "fails closed before installing blocked ambiguous npm plugin spec %s",
    async (spec) => {
      primeBlockedPluginConfigMutation();
      installHooksFromNpmSpecMock.mockResolvedValue({
        ok: false,
        error: "package.json missing openclaw.hooks",
      });

      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", spec]),
      ).rejects.toThrow("__exit__:1");

      expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(1);
      expect(hookNpmInstallCall().inspection).toBe("package-kind");
      expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins are stored in an external or unresolved top-level $include",
      );
    },
  );

  it("installs a positively identified npm hook pack without probing plugin installation", async () => {
    const installedCfg = {
      hooks: {
        internal: {
          installs: {
            "demo-hooks": {
              source: "npm",
              spec: "@acme/demo-hooks@1.2.3",
            },
          },
        },
      },
    } as OpenClawConfig;
    primeBlockedPluginConfigMutation();
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      packageKind: "hook-only",
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
      npmResolution: {
        name: "@acme/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });
    recordHookInstallMock.mockReturnValue(installedCfg);

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(2);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(hookNpmInstallCall(1).expectedIntegrity).toBe("sha256-demo");
    expect(hookNpmInstallCall(1).expectedPackageKind).toBe("hook-only");
    expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
  });

  it("blocks npm package inspection when plugin and hook config are include-owned", async () => {
    primeBlockedPluginConfigMutation({ blockHooks: true });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
      npmResolution: {
        name: "@acme/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo-hooks"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks a proven npm hook pack before plugin installer side effects when only hooks config is include-owned", async () => {
    primeBlockedHookConfigMutation();
    installHooksFromNpmSpecMock.mockResolvedValue({
      ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
      npmResolution: {
        name: "@acme/demo-hooks",
        version: "1.2.3",
        resolvedSpec: "@acme/demo-hooks@1.2.3",
        integrity: "sha256-demo",
      },
    });

    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "@acme/demo-hooks",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(hookNpmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks local package inspection when plugin and hook config are include-owned", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-pack-"));
    primeBlockedPluginConfigMutation({ blockHooks: true });
    installHooksFromPathMock.mockResolvedValue(createHookPackInstallResult(localPath));
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.extensions",
      code: "missing_openclaw_extensions",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks a proven local hook pack before plugin installer side effects when only hooks config is include-owned", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-pack-"));
    primeBlockedHookConfigMutation();
    installHooksFromPathMock.mockResolvedValue(createHookPackInstallResult(localPath));

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config hooks are stored in an external or unresolved top-level $include",
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves local hook-pack precedence for prefix-shaped paths",
    async () => {
      const localPath = path.join(process.cwd(), `clawhub:demo-hooks-${process.pid}`);
      const installedCfg = {
        hooks: {
          internal: {
            installs: {
              "demo-hooks": {
                source: "path",
                sourcePath: localPath,
              },
            },
          },
        },
      } as OpenClawConfig;
      fs.mkdirSync(localPath);
      primeBlockedPluginConfigMutation();
      parseClawHubPluginSpecMock.mockReturnValue({ name: "demo-hooks" });
      installPluginFromPathMock.mockResolvedValue({
        ok: false,
        error: "package.json missing openclaw.extensions",
        code: "missing_openclaw_extensions",
      });
      installHooksFromPathMock.mockResolvedValue(createHookPackInstallResult(localPath));
      recordHookInstallMock.mockReturnValue(installedCfg);

      try {
        await runAcknowledgedPluginsInstallCommand([
          "plugins",
          "install",
          path.basename(localPath),
        ]);
      } finally {
        fs.rmSync(localPath, { recursive: true, force: true });
      }

      expect(installPluginFromPathMock).not.toHaveBeenCalled();
      expect(installHooksFromPathMock).toHaveBeenCalledTimes(2);
      expect(hookPathInstallCall().inspection).toBe("package-kind");
      expect(hookPathInstallCall(1).expectedPackageKind).toBe("hook-only");
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
      expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
    },
  );

  it("fails closed for ambiguous npm plugins when the whole config is include-owned", async () => {
    primeBlockedRootConfigMutation();
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo-plugin"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("unsupported $include shape at the root");
  });

  it("fails closed for ambiguous local plugins when the whole config is include-owned", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-demo-plugin-"));
    primeBlockedRootConfigMutation();
    installHooksFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).not.toHaveBeenCalled();
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("unsupported $include shape at the root");
  });

  it("fails closed before installing a blocked ambiguous local plugin", async () => {
    const archivePath = path.join(os.tmpdir(), `openclaw-plugin-${process.pid}.tgz`);
    fs.writeFileSync(archivePath, "not-an-archive");
    primeBlockedPluginConfigMutation();
    installHooksFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", archivePath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(archivePath, { force: true });
    }

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed when an npm hook probe finds a plugin-capable package", async () => {
    primeBlockedPluginConfigMutation();
    installHooksFromNpmSpecMock.mockResolvedValue({
      ...createHookPackInstallResult("/tmp/hooks/demo-hooks"),
      packageKind: "plugin-capable",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/dual-package"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed when a local hook probe finds a plugin-capable package", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dual-package-"));
    primeBlockedPluginConfigMutation();
    installHooksFromPathMock.mockResolvedValue({
      ...createHookPackInstallResult(localPath),
      packageKind: "plugin-capable",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed for a local bundle plugin instead of installing its hooks", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundle-plugin-"));
    primeBlockedPluginConfigMutation();
    installHooksFromPathMock.mockResolvedValue({
      ...createHookPackInstallResult(localPath),
      packageKind: "plugin-capable",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPath]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed when a blocked-config npm hook probe throws", async () => {
    primeBlockedPluginConfigMutation();
    installHooksFromNpmSpecMock.mockRejectedValue(new Error("hook validation exploded"));

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo-plugin"]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(hookNpmInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("fails closed when a blocked-config local hook probe throws", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    primeBlockedPluginConfigMutation();
    installHooksFromPathMock.mockRejectedValue(new Error("hook validation exploded"));

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPluginDir]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).toHaveBeenCalledTimes(1);
    expect(hookPathInstallCall().inspection).toBe("package-kind");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it.each([
    {
      label: "marketplace",
      args: ["plugins", "install", "demo", "--marketplace", "local/repo"],
      installer: installPluginFromMarketplaceMock,
      setup: () =>
        installPluginFromMarketplaceMock.mockResolvedValue({
          ok: true,
          pluginId: "demo",
          targetDir: cliInstallPath("demo"),
          extensions: ["index.js"],
          version: "1.2.3",
          marketplaceName: "Claude",
          marketplaceSource: "local/repo",
          marketplacePlugin: "demo",
        }),
    },
    {
      label: "git",
      args: ["plugins", "install", "git:github.com/acme/demo"],
      installer: installPluginFromGitSpecMock,
      setup: () => installPluginFromGitSpecMock.mockResolvedValue(createGitPluginInstallResult()),
    },
    {
      label: "npm-pack",
      args: ["plugins", "install", "npm-pack:/tmp/demo.tgz"],
      installer: installPluginFromNpmPackArchiveMock,
      setup: () =>
        installPluginFromNpmPackArchiveMock.mockResolvedValue(createNpmPackPluginInstallResult()),
    },
    {
      label: "ClawHub",
      args: ["plugins", "install", "clawhub:demo"],
      installer: installPluginFromClawHubMock,
      setup: () => {
        parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
        installPluginFromClawHubMock.mockResolvedValue(
          createClawHubInstallResult({
            pluginId: "demo",
            packageName: "demo",
            version: "1.2.3",
            channel: "stable",
          }),
        );
      },
    },
  ])(
    "blocks explicit $label plugin installs before installer side effects",
    async ({ args, installer, setup }) => {
      primeBlockedPluginConfigMutation();
      setup();

      const commandArgs =
        args[2] === "clawhub:demo" ? args : withNonClawHubInstallAcknowledgement(args);
      await expect(runPluginsCommand(commandArgs)).rejects.toThrow("__exit__:1");

      expect(installer).not.toHaveBeenCalled();
      expect(configWriteMock).not.toHaveBeenCalled();
      expect(runtimeErrors.at(-1)).toContain(
        "Config plugins are stored in an external or unresolved top-level $include",
      );
    },
  );

  it("blocks bare official plugins before installer side effects", async () => {
    primeBlockedPluginConfigMutation();
    findBundledPluginSourceMock.mockReturnValue(undefined);

    await expect(runPluginsCommand(["plugins", "install", "brave"])).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks bare bundled plugin ids before installer side effects", async () => {
    const pluginId = "config-required-plugin";
    primeBlockedPluginConfigMutation();
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
    });

    await expect(runPluginsCommand(["plugins", "install", pluginId])).rejects.toThrow("__exit__:1");

    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "Config plugins are stored in an external or unresolved top-level $include",
    );
  });

  it("blocks explicit plugins through nested include config before installer side effects", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-nested-"));
    primeNestedPluginConfigMutation(tempRoot);
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      extensions: ["index.js"],
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "demo",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand([
          "plugins",
          "install",
          "demo",
          "--marketplace",
          "local/repo",
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("nested $include");
  });

  it("exits when --marketplace is combined with --link", async () => {
    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--link",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("--link is not supported with --marketplace.");
    expect(runtimeErrors.at(-1)).toContain("openclaw plugins install --link <path> --force");
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
  });

  it("exits when marketplace install fails", async () => {
    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("passes the active profile extensions dir to marketplace installs", async () => {
    const extensionsDir = useProfileExtensionsDir();

    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().extensionsDir).toBe(extensionsDir);
    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
  });

  it("fails closed for unrelated invalid config before installer side effects", async () => {
    const invalidConfigErr = new Error("config invalid");
    (invalidConfigErr as { code?: string }).code = "INVALID_CONFIG";
    pluginCliConfigMock.mockImplementation(() => {
      throw invalidConfigErr;
    });
    readConfigFileSnapshotMock.mockResolvedValue({
      path: "/tmp/openclaw-config.json5",
      exists: true,
      raw: '{ "models": { "default": 123 } }',
      parsed: { models: { default: 123 } },
      resolved: { models: { default: 123 } },
      valid: false,
      config: { models: { default: 123 } },
      hash: "mock",
      issues: [{ path: "models.default", message: "invalid model ref" }],
      warnings: [],
      legacyIssues: [],
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "alpha"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Config invalid; run `openclaw doctor --fix` before installing plugins.",
    );
    expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
  });

  it("installs marketplace plugins and persists plugin index", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = {
      plugins: {
        entries: {
          alpha: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(cfg);
    installPluginFromMarketplaceMock.mockResolvedValue({
      ok: true,
      pluginId: "alpha",
      targetDir: cliInstallPath("alpha"),
      extensions: ["index.js"],
      version: "1.2.3",
      marketplaceName: "Claude",
      marketplaceSource: "local/repo",
      marketplacePlugin: "alpha",
    });
    enablePluginInConfigMock.mockReturnValue({ config: enabledCfg, enabled: true });
    buildPluginSnapshotReportMock.mockReturnValue({
      plugins: [{ id: "alpha", kind: "provider" }],
      diagnostics: [],
    });
    const alphaRoot = cliInstallPath("alpha");
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        recordPluginManifestInstallOwner(
          {
            id: "alpha",
            kind: "memory",
            origin: "global",
            channels: [],
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            rootDir: alphaRoot,
            source: `${alphaRoot}/index.js`,
            manifestPath: `${alphaRoot}/openclaw.plugin.json`,
          },
          "alpha",
        ),
      ],
      diagnostics: [],
    });
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: enabledCfg,
      warnings: ["slot adjusted"],
    });

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "alpha",
      "--marketplace",
      "local/repo",
    ]);

    expect(persistedInstallRecord("alpha").source).toBe("marketplace");
    expect(persistedInstallRecord("alpha").installPath).toBe(cliInstallPath("alpha"));
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    expect(replaceConfigCall().baseHash).toBe("mock");
    expect(replaceConfigCall().nextConfig).toBe(enabledCfg);
    expect(runtimeLogsContain("slot adjusted")).toBe(true);
    expect(runtimeLogsContain("Installed plugin: alpha")).toBe(true);
    expect(clearPluginRegistryLoadCacheMock).not.toHaveBeenCalled();
  });

  it("passes force through as overwrite mode for marketplace installs", async () => {
    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--force",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(marketplaceInstallCall().mode).toBe("update");
  });

  it("requires acknowledgement for noninteractive non-ClawHub plugin installs", async () => {
    setTty(false);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await expect(runPluginsCommand(["plugins", "install", "npm:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("outside ClawHub review");
    expect(runtimeErrors.at(-1)).toContain(NON_CLAWHUB_INSTALL_FORCE_FLAG);
  });

  it.each([
    {
      label: "npm-pack",
      prepare: () => ({
        args: ["plugins", "install", "npm-pack:/tmp/demo.tgz"],
        expectNoInstallerSideEffects: () =>
          expect(installPluginFromNpmPackArchiveMock).not.toHaveBeenCalled(),
      }),
    },
    {
      label: "git",
      prepare: () => ({
        args: ["plugins", "install", "git:github.com/acme/demo@v1.2.3"],
        expectNoInstallerSideEffects: () =>
          expect(installPluginFromGitSpecMock).not.toHaveBeenCalled(),
      }),
    },
    {
      label: "marketplace",
      prepare: () => ({
        args: ["plugins", "install", "demo", "--marketplace", "local/repo"],
        expectNoInstallerSideEffects: () =>
          expect(installPluginFromMarketplaceMock).not.toHaveBeenCalled(),
      }),
    },
    {
      label: "local path",
      prepare: () => {
        const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-"));
        return {
          args: ["plugins", "install", localPath],
          cleanup: () => fs.rmSync(localPath, { recursive: true, force: true }),
          expectNoInstallerSideEffects: () =>
            expect(installPluginFromPathMock).not.toHaveBeenCalled(),
        };
      },
    },
    {
      label: "local archive",
      prepare: () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-"));
        const archivePath = `${tempRoot}.tgz`;
        fs.writeFileSync(archivePath, "archive");
        return {
          args: ["plugins", "install", archivePath],
          cleanup: () => {
            fs.rmSync(archivePath, { force: true });
            fs.rmSync(tempRoot, { recursive: true, force: true });
          },
          expectNoInstallerSideEffects: () =>
            expect(installPluginFromPathMock).not.toHaveBeenCalled(),
        };
      },
    },
  ])(
    "requires acknowledgement for noninteractive $label installs before installer side effects",
    async ({ prepare }) => {
      setTty(false);
      const prepared: {
        args: string[];
        cleanup?: () => void;
        expectNoInstallerSideEffects: () => void;
      } = prepare();

      try {
        await expect(runPluginsCommand(prepared.args)).rejects.toThrow("__exit__:1");
      } finally {
        prepared.cleanup?.();
      }

      prepared.expectNoInstallerSideEffects();
      expect(runtimeErrors.at(-1)).toContain("outside ClawHub review");
      expect(runtimeErrors.at(-1)).toContain(NON_CLAWHUB_INSTALL_FORCE_FLAG);
    },
  );

  it("does not require acknowledgement for a bundled plugin's local source path", async () => {
    const localPath = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-plugin-source-"));
    findBundledPluginSourceMock.mockImplementation((params: unknown) => {
      const { lookup } = params as {
        lookup: { kind: "localPath" | "npmSpec" | "pluginId"; value: string };
      };
      return lookup.kind === "localPath" && path.resolve(lookup.value) === path.resolve(localPath)
        ? { pluginId: "demo", localPath }
        : undefined;
    });
    primeSuccessfulPluginPersistence("demo");
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.0.0",
      extensions: ["index.js"],
    });

    try {
      await runPluginsCommand(["plugins", "install", localPath]);
    } finally {
      fs.rmSync(localPath, { recursive: true, force: true });
    }

    expect(promptYesNoMock).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).not.toContain("outside ClawHub review");
    expect(installPluginFromPathMock).toHaveBeenCalledTimes(1);
  });

  it("prompts interactive users before non-ClawHub plugin installs and cancels on no", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(false);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await expect(runPluginsCommand(["plugins", "install", "npm:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(promptYesNoMock).toHaveBeenCalledWith("Install this non-ClawHub plugin source?");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("prompts interactive users before non-ClawHub plugin installs and proceeds on yes", async () => {
    setTty(true);
    promptYesNoMock.mockResolvedValueOnce(true);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runPluginsCommand(["plugins", "install", "npm:demo"]);

    expect(promptYesNoMock).toHaveBeenCalledWith("Install this non-ClawHub plugin source?");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(persistedInstallRecord("demo").source).toBe("npm");
  });

  it.each([
    {
      label: "npm",
      args: ["plugins", "install", "npm:demo"],
      expectedSource: "npm registry",
      setup: () => {
        primeSuccessfulPluginPersistence("demo");
        installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));
      },
    },
    {
      label: "npm-pack",
      args: ["plugins", "install", "npm-pack:/tmp/demo.tgz"],
      expectedSource: "local npm-pack archive",
      setup: () => {
        primeSuccessfulPluginPersistence("demo");
        installPluginFromNpmPackArchiveMock.mockResolvedValue(
          createNpmPackPluginInstallResult("demo"),
        );
      },
    },
    {
      label: "git",
      args: ["plugins", "install", "git:github.com/acme/demo@v1.2.3"],
      expectedSource: "Git repository",
      setup: () => {
        primeSuccessfulPluginPersistence("demo");
        installPluginFromGitSpecMock.mockResolvedValue(createGitPluginInstallResult("demo"));
      },
    },
    {
      label: "marketplace",
      args: ["plugins", "install", "demo", "--marketplace", "local/repo"],
      expectedSource: "marketplace source",
      setup: () => {
        primeSuccessfulPluginPersistence("demo");
        installPluginFromMarketplaceMock.mockResolvedValue({
          ok: true,
          pluginId: "demo",
          targetDir: cliInstallPath("demo"),
          extensions: ["index.js"],
          version: "1.2.3",
          marketplaceName: "Claude",
          marketplaceSource: "local/repo",
          marketplacePlugin: "demo",
        });
      },
    },
  ])(
    "warns for acknowledged $label installs outside ClawHub",
    async ({ args, expectedSource, setup }) => {
      setup();

      await runAcknowledgedPluginsInstallCommand(args);

      expect(runtimeLogsContain(`Installing plugin from ${expectedSource}`)).toBe(true);
      expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    },
  );

  it.each([
    {
      label: "local path",
      expectedSource: "local path",
      suffix: "",
    },
    {
      label: "local archive",
      expectedSource: "local archive",
      suffix: ".tgz",
    },
  ])(
    "warns for acknowledged $label installs outside ClawHub",
    async ({ expectedSource, suffix }) => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-source-"));
      const localSource = suffix ? `${tempRoot}${suffix}` : tempRoot;
      if (suffix) {
        fs.writeFileSync(localSource, "archive");
      }
      primeSuccessfulPluginPersistence("demo");
      installPluginFromPathMock.mockResolvedValue({
        ok: true,
        pluginId: "demo",
        targetDir: cliInstallPath("demo"),
        version: "1.2.3",
        extensions: ["./dist/index.js"],
      });

      try {
        await runAcknowledgedPluginsInstallCommand(["plugins", "install", localSource]);
      } finally {
        fs.rmSync(localSource, { recursive: true, force: true });
        if (suffix) {
          fs.rmSync(tempRoot, { recursive: true, force: true });
        }
      }

      expect(runtimeLogsContain(`Installing plugin from ${expectedSource}`)).toBe(true);
      expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    },
  );

  it("installs the beta artifact for an official ClawHub plugin on a beta gateway", async () => {
    primeSuccessfulClawHubPluginInstall();
    parseClawHubPluginSpecMock.mockReturnValue({ name: "@openclaw/brave-plugin" });
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);

    await runCapabilityAcceptedPluginsInstallCommand([
      "plugins",
      "install",
      "clawhub:@openclaw/brave-plugin",
    ]);

    expect(clawHubInstallCall().spec).toBe("clawhub:@openclaw/brave-plugin@beta");
  });

  it("does not install a stable ClawHub release when no beta release exists", async () => {
    primeSuccessfulClawHubPluginInstall();
    parseClawHubPluginSpecMock.mockReturnValue({ name: "@openclaw/brave-plugin" });
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      error: "Version not found on ClawHub: @openclaw/brave-plugin@beta.",
      code: "version_not_found",
    });

    await expect(
      runPluginsCommand(["plugins", "install", "clawhub:@openclaw/brave-plugin"]),
    ).rejects.toThrow("__exit__:1");

    expect(clawHubInstallCall(0).spec).toBe("clawhub:@openclaw/brave-plugin@beta");
    expect(installPluginFromClawHubMock).toHaveBeenCalledTimes(1);
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "No clawhub:@openclaw/brave-plugin@beta release is published for this gateway",
    );
  });

  it("leaves a non-official ClawHub install on the operator selector", async () => {
    primeSuccessfulClawHubPluginInstall();
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]);

    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
  });

  it("does not show the non-ClawHub warning for explicit ClawHub installs", async () => {
    primeSuccessfulClawHubPluginInstall();
    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]);

    expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("passes a generic install confirmation to interactive ClawHub installs", async () => {
    setTty(true);
    primeSuccessfulClawHubPluginInstall();

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]);

    expect(clawHubInstallCall().confirmInstall).toEqual(expect.any(Function));
  });

  it("rejects unacknowledged noninteractive ClawHub installs before persistence", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await expect(runPluginsCommand(["plugins", "install", "clawhub:demo"])).rejects.toThrow(
      "--accept-capabilities",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(writePersistedInstalledPluginIndexInstallRecordsWithLeaseMock).not.toHaveBeenCalled();
    expect(reportClawHubPluginInstallTelemetryMock).not.toHaveBeenCalled();
  });

  it("installs ClawHub plugins and persists source metadata", async () => {
    const { enabledCfg } = primeSuccessfulClawHubPluginInstall();

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]);

    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("clawhub");
    expect(record.spec).toBe("clawhub:demo");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.clawhubPackage).toBe("demo");
    expect(record.clawhubFamily).toBe("code-plugin");
    expect(record.clawhubChannel).toBe("official");
    expect(record.clawpackSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(record.clawpackSpecVersion).toBe(1);
    expect(record.clawpackManifestSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(record.clawpackSize).toBe(4096);
    expect(record.acceptedSurfaceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(record.acceptedSurfaceIntegrity).toBe("sha256-abc");
    expect(readConfigFileSnapshotForWriteMock).toHaveBeenCalledTimes(2);
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogsContain("Installed plugin: demo")).toBe(true);
    expect(reportClawHubPluginInstallTelemetryMock).toHaveBeenCalledWith({
      baseUrl: "https://clawhub.ai",
      packageName: "demo",
      version: "1.2.3",
    });
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
  });

  it("preserves invocation-wide policy acknowledgement across the ClawHub lifecycle lease", async () => {
    setTty(false);
    primeSuccessfulClawHubPluginInstall();

    await runCapabilityAcceptedPluginsInstallCommand([
      "plugins",
      "install",
      "clawhub:demo",
      "--acknowledge-install-policy-warning",
    ]);

    const acknowledgement = clawHubInstallCall().onInstallPolicyWarning;
    if (typeof acknowledgement !== "function") {
      throw new Error("expected ClawHub install-policy acknowledgement callback");
    }
    await expect(
      acknowledgement({
        targetName: "demo",
        targetType: "plugin",
        requestMode: "install",
      }),
    ).resolves.toEqual({ status: "approved" });
    await expect(
      acknowledgement({
        targetName: "demo-dependency",
        targetType: "plugin",
        requestMode: "install",
      }),
    ).resolves.toEqual({ status: "approved" });
  });

  it("does not report a ClawHub install when durable persistence fails", async () => {
    primeSuccessfulClawHubPluginInstall();
    configWriteMock.mockRejectedValueOnce(new Error("persistence failed"));

    await expect(
      runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]),
    ).rejects.toThrow("persistence failed");

    expect(reportClawHubPluginInstallTelemetryMock).not.toHaveBeenCalled();
  });

  it("prints blocked ClawHub download failures when no trust warning was emitted", async () => {
    pluginCliConfigMock.mockReturnValue(createEmptyPluginConfig());
    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      code: "clawhub_download_blocked",
      error:
        'ClawHub blocked artifact download for "demo@1.2.3"; install was not started. ClawHub /api/v1/packages/demo/versions/1.2.3/artifact/download failed (403): blocked.',
    });

    await expect(runPluginsCommand(["plugins", "install", "clawhub:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors.at(-1)).toContain("ClawHub blocked artifact download");
  });

  it("passes the active profile extensions dir to ClawHub installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    primeSuccessfulClawHubPluginInstall();

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo"]);

    expect(clawHubInstallCall().extensionsDir).toBe(extensionsDir);
    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
  });

  it("preserves non-config policy for unconfigured bundled installs", async () => {
    const pluginId = "config-required-plugin";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: {
            hooks: { timeoutMs: 5_000 },
          },
        },
        load: {
          paths: ["/existing/plugin"],
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
      configSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: {
            type: "string",
          },
        },
      },
      requiresConfig: true,
    });

    await runPluginsCommand(["plugins", "install", pluginId]);

    const writtenConfig = configWriteMock.mock.calls[
      configWriteMock.mock.calls.length - 1
    ]?.[0] as OpenClawConfig;
    expect(writtenConfig.plugins?.entries?.[pluginId]).toEqual({
      enabled: false,
      hooks: { timeoutMs: 5_000 },
    });
    expect(writtenConfig.plugins?.load?.paths).toEqual(["/existing/plugin"]);
    const record = persistedInstallRecord(pluginId);
    expect(record.source).toBe("path");
    expect(String(record.sourcePath)).toContain(pluginId);
    expect(String(record.installPath)).toContain(pluginId);
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
    expect(applyExclusiveSlotSelectionMock).not.toHaveBeenCalled();
    expect(runtimeLogsContain("requires configuration first")).toBe(true);
  });

  it("rejects invalid authored config for config-gated bundled installs", async () => {
    const pluginId = "config-required-plugin";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: {
            config: {},
            hooks: { timeoutMs: 5_000 },
          },
        },
      },
    } as OpenClawConfig;
    pluginCliConfigMock.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
      configSchema: {
        type: "object",
        required: ["token"],
        properties: { token: { type: "string" } },
      },
      requiresConfig: true,
    });

    await expect(runPluginsCommand(["plugins", "install", pluginId])).rejects.toThrow(
      "has invalid configured settings",
    );

    expect(configWriteMock).not.toHaveBeenCalled();
    expect(enablePluginInConfigMock).not.toHaveBeenCalled();
  });

  it("enables config-gated bundled installs when provider-backed config is explicit", async () => {
    const pluginId = "config-required-plugin";
    const cfg = {
      plugins: {
        entries: {
          [pluginId]: {
            config: {
              token: "sk-test",
            },
          },
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig(pluginId);
    pluginCliConfigMock.mockReturnValue(cfg);
    findBundledPluginSourceMock.mockReturnValue({
      pluginId,
      localPath: `/app/dist/extensions/${pluginId}`,
      configSchema: {
        type: "object",
        required: ["token"],
        properties: {
          token: {
            type: "string",
          },
        },
      },
      requiresConfig: true,
    });
    enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });

    await runPluginsCommand(["plugins", "install", pluginId]);

    expect(enablePluginInConfigMock).toHaveBeenCalledTimes(1);
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
    expect(runtimeLogsContain("requires configuration first")).toBe(false);
  });

  it("passes force through as overwrite mode for ClawHub installs", async () => {
    primeSuccessfulClawHubPluginInstall();

    await runCapabilityAcceptedPluginsInstallCommand([
      "plugins",
      "install",
      "clawhub:demo",
      "--force",
    ]);

    expect(clawHubInstallCall().spec).toBe("clawhub:demo");
    expect(clawHubInstallCall().mode).toBe("update");
  });

  it("keeps explicit ClawHub versions pinned in install records", async () => {
    primeSuccessfulClawHubPluginInstall({ explicitVersion: true });

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "clawhub:demo@1.2.3"]);

    expect(clawHubInstallCall().spec).toBe("clawhub:demo@1.2.3");
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("clawhub");
    expect(record.spec).toBe("clawhub:demo@1.2.3");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.clawhubPackage).toBe("demo");
    expect(record.clawpackSha256).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(record.clawpackSpecVersion).toBe(1);
    expect(record.clawpackManifestSha256).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
    expect(record.clawpackSize).toBe(4096);
  });

  it("resolves exact official external plugin ids through their npm package", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("brave");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("brave"));

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "brave"]);

    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "pluginId", value: "brave" },
    });
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("@openclaw/brave-plugin");
    expect(npmInstallCall().expectedPluginId).toBe("brave");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
    const record = persistedInstallRecord("brave");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("@openclaw/brave-plugin");
    expect(record.installPath).toBe(cliInstallPath("brave"));
    expect(record.version).toBe("1.2.3");
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
  });

  it.each(
    [
      { version: "2026.8.1", channel: "beta" },
      { version: "2026.8.1-beta.4", channel: undefined },
      { version: "2026.8.1-beta.4", channel: "stable" },
    ].flatMap(({ version, channel }) =>
      ["brave", "@openclaw/brave-plugin"].map((arg) => ({ version, channel, arg })),
    ),
  )(
    "installs beta for $arg on core $version with channel $channel",
    async ({ version, channel, arg }) => {
      coreVersion.value = version;
      primeSuccessfulPluginPersistence("brave");
      pluginCliConfigMock.mockReturnValue({
        ...createEmptyPluginConfig(),
        ...(channel ? { update: { channel } } : {}),
      } as OpenClawConfig);
      findBundledPluginSourceMock.mockReturnValue(undefined);
      installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("brave"));

      await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", arg]);

      expect(npmInstallCall().spec).toBe("@openclaw/brave-plugin@beta");
      expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
      // The record keeps the operator's selector so a later channel change is
      // not silently pinned to the beta dist-tag.
      expect(persistedInstallRecord("brave").spec).toBe("@openclaw/brave-plugin");
    },
  );

  it("does not install the stable release when no beta artifact is published", async () => {
    primeSuccessfulPluginPersistence("brave");
    pluginCliConfigMock.mockReturnValue({
      ...createEmptyPluginConfig(),
      update: { channel: "beta" },
    } as OpenClawConfig);
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "npm error code ETARGET No matching version found for @openclaw/brave-plugin@beta",
      code: "npm_package_not_found",
    });

    await expect(runPluginsCommand(["plugins", "install", "brave"])).rejects.toThrow("__exit__:1");

    expect(npmInstallCall(0).spec).toBe("@openclaw/brave-plugin@beta");
    expect(installPluginFromNpmSpecMock).toHaveBeenCalledTimes(1);
    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "No @openclaw/brave-plugin@beta release is published for this gateway",
    );
  });

  it("passes third-party external catalog integrity with catalog install trust", async () => {
    coreVersion.value = "2026.8.1-beta.4";
    primeSuccessfulPluginPersistence("wecom-openclaw-plugin");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue(
      createNpmPluginInstallResult("wecom-openclaw-plugin"),
    );

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "wecom"]);

    expect(npmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");
    expect(npmInstallCall().expectedPluginId).toBe("wecom-openclaw-plugin");
    expect(npmInstallCall().expectedIntegrity).toBe(
      "sha512-7kqdBIOF3SgDDoBoFtO6jxnxofbYSgbKdxZDNabD0y0jg2xKcVqlXZOOJ9+XQho/QOtIFrnRH2IRnPukFEYwJg==",
    );
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
  });

  it.each(OFFICIAL_EXTERNAL_NPM_INSTALLS_WITHOUT_INTEGRITY)(
    "keeps official external npm installs trusted without integrity for $pluginId",
    async ({ pluginId, npmSpec }) => {
      await withTempDir("openclaw-official-plugin-install-", async (cwd) => {
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
        try {
          primeSuccessfulPluginPersistence(pluginId);
          findBundledPluginSourceMock.mockReturnValue(undefined);
          installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult(pluginId));

          await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", pluginId]);

          expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
            lookup: { kind: "pluginId", value: pluginId },
          });
          expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
          expect(npmInstallCall().spec).toBe(npmSpec);
          expect(npmInstallCall().expectedPluginId).toBe(pluginId);
          expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
          expect(npmInstallCall().expectedIntegrity).toBeUndefined();
        } finally {
          cwdSpy.mockRestore();
        }
      });
    },
  );

  it("passes third-party external catalog integrity to hook-pack fallback", async () => {
    pluginCliConfigMock.mockReturnValue(createEmptyPluginConfig());
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.extensions",
      code: "missing_openclaw_extensions",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error:
        "aborted: npm package integrity drift detected for @wecom/wecom-openclaw-plugin@2026.7.2",
    });

    await expect(runPluginsCommand(["plugins", "install", "wecom"])).rejects.toThrow("__exit__:1");

    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(hookNpmInstallCall().spec).toBe("@wecom/wecom-openclaw-plugin@2026.7.2");
    expect(hookNpmInstallCall().expectedIntegrity).toBe(
      "sha512-7kqdBIOF3SgDDoBoFtO6jxnxofbYSgbKdxZDNabD0y0jg2xKcVqlXZOOJ9+XQho/QOtIFrnRH2IRnPukFEYwJg==",
    );
  });

  it("installs ordinary bare plugin specs through npm without ClawHub lookup", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "demo"]);

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("demo");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("demo");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
  });

  it("stores npm resolution metadata without changing the active plugin install selector", async () => {
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: cliInstallPath("demo"),
      version: "1.2.3",
      npmResolution: {
        name: "demo",
        version: "1.2.3",
        resolvedSpec: "demo@1.2.3",
        integrity: "sha512-demo",
      },
    });
    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "demo"]);

    const record = persistedInstallRecord("demo");
    expect(record.spec).toBe("demo");
    expect(record.resolvedSpec).toBe("demo@1.2.3");
    expect(record.integrity).toBe("sha512-demo");
  });

  it("passes bare npm selectors through npm without ClawHub lookup", async () => {
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "demo@beta"]);

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(npmInstallCall().spec).toBe("demo@beta");
  });

  it("installs directly from npm when npm: prefix is used", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:demo"]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("update");
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(persistedInstallRecord("demo").source).toBe("npm");
    expect(persistedInstallRecord("demo").spec).toBe("demo");
    expect(persistedInstallRecord("demo").installPath).toBe(cliInstallPath("demo"));
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
  });

  it("installs npm-pack archives through npm install semantics", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("demo");
    const archivePath = "/tmp/openclaw-demo-1.2.3.tgz";
    installPluginFromNpmPackArchiveMock.mockResolvedValue(createNpmPackPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", `npm-pack:${archivePath}`]);

    expect(npmPackInstallCall().archivePath).toBe(archivePath);
    expect(npmPackInstallCall().mode).toBe("update");
    expect(installPluginFromPathMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("npm");
    expect(record.spec).toBe("@openclaw/demo@1.2.3");
    expect(record.sourcePath).toBe(archivePath);
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.version).toBe("1.2.3");
    expect(record.artifactKind).toBe("npm-pack");
    expect(record.artifactFormat).toBe("tgz");
    expect(record.npmIntegrity).toBe("sha512-pack-demo");
    expect(record.npmShasum).toBe("packdemosha");
    expect(record.npmTarballName).toBe("openclaw-demo-1.2.3.tgz");
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
  });

  it("keeps npm-prefixed official plugin ids on explicit npm semantics", async () => {
    primeSuccessfulPluginPersistence("brave");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("brave"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:brave"]);

    expect(npmInstallCall().spec).toBe("brave");
    expect(npmInstallCall().expectedPluginId).toBeUndefined();
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBeUndefined();
    expect(runtimeLogsContain("Installing plugin from npm registry")).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(true);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("marks explicit official npm package installs as trusted", async () => {
    primeSuccessfulPluginPersistence("discord");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("discord"));

    await runCapabilityAcceptedPluginsInstallCommand([
      "plugins",
      "install",
      "npm:@openclaw/discord",
    ]);

    expect(npmInstallCall().spec).toBe("@openclaw/discord");
    expect(npmInstallCall().expectedPluginId).toBe("discord");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("marks scoped official npm package installs as trusted", async () => {
    primeSuccessfulPluginPersistence("discord");
    findBundledPluginSourceMock.mockReturnValue(undefined);
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("discord"));

    await runCapabilityAcceptedPluginsInstallCommand(["plugins", "install", "@openclaw/discord"]);

    expect(npmInstallCall().spec).toBe("@openclaw/discord");
    expect(npmInstallCall().expectedPluginId).toBe("discord");
    expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("uses bundled OpenClaw package specs instead of pinning stale managed npm overrides", async () => {
    primeSuccessfulPluginPersistence("discord");
    const bundledPath = "/app/dist/extensions/discord";
    findBundledPluginSourceMock.mockImplementation((params: unknown) => {
      const { lookup } = params as {
        lookup: { kind: "pluginId" | "npmSpec"; value: string };
      };
      return lookup.kind === "npmSpec" && lookup.value === "@openclaw/discord"
        ? {
            pluginId: "discord",
            localPath: bundledPath,
            npmSpec: "@openclaw/discord",
            version: "2026.5.24-beta.2",
          }
        : undefined;
    });
    await runPluginsCommand([
      "plugins",
      "install",
      "@openclaw/discord@2026.5.20",
      "--pin",
      "--force",
    ]);

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "npmSpec", value: "@openclaw/discord@2026.5.20" },
    });
    expect(findBundledPluginSourceMock).toHaveBeenCalledWith({
      lookup: { kind: "npmSpec", value: "@openclaw/discord" },
    });
    const record = persistedInstallRecord("discord");
    expect(record.source).toBe("path");
    expect(record.spec).toBe("@openclaw/discord@2026.5.20");
    expect(record.sourcePath).toBe(bundledPath);
    expect(record.installPath).toBe(bundledPath);
    expect(runtimeLogsContain("ships with the current OpenClaw build")).toBe(true);
    expect(runtimeLogsContain("npm:@openclaw/discord@2026.5.20")).toBe(true);
  });

  it.each([
    { version: "2026.8.1", selector: "latest", installSelector: "latest" },
    { version: "2026.8.1-beta.4", selector: "latest", installSelector: "beta" },
    { version: "2026.8.1-beta.4", selector: "next", installSelector: "next" },
    { version: "2026.8.1-beta.4", selector: "2026.6.1", installSelector: "2026.6.1" },
  ])(
    "trusts catalog npm @$selector on core $version",
    async ({ version, selector, installSelector }) => {
      coreVersion.value = version;
      primeSuccessfulPluginPersistence("wecom-openclaw-plugin");
      findBundledPluginSourceMock.mockReturnValue(undefined);
      installPluginFromNpmSpecMock.mockResolvedValue(
        createNpmPluginInstallResult("wecom-openclaw-plugin"),
      );

      await runCapabilityAcceptedPluginsInstallCommand([
        "plugins",
        "install",
        `@wecom/wecom-openclaw-plugin@${selector}`,
      ]);

      // Alternate selectors stay trusted by catalog package name, but must not
      // inherit catalog integrity unless the install spec matches exactly.
      expect(npmInstallCall().spec).toBe(`@wecom/wecom-openclaw-plugin@${installSelector}`);
      expect(npmInstallCall().expectedPluginId).toBe("wecom-openclaw-plugin");
      expect(npmInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
      expect(npmInstallCall().expectedIntegrity).toBeUndefined();
      expect(runtimeLogsContain("outside ClawHub review")).toBe(false);
      expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    },
  );

  it("passes the active profile extensions dir to npm installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:demo"]);

    expect(npmInstallCall().extensionsDir).toBe(extensionsDir);
    expect(npmInstallCall().spec).toBe("demo");
  });

  it("passes npm: prefix installs through npm options without ClawHub lookup", async () => {
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "npm:demo",
      "--force",
      "--dangerously-force-unsafe-install",
    ]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("update");
    expect(npmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
    expect(
      pluginsCliRuntimeLogs.filter((message) =>
        message.includes(
          "--dangerously-force-unsafe-install is deprecated and no longer affects plugin installs",
        ),
      ),
    ).toHaveLength(1);
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
  });

  it("passes an install-policy warning prompt to interactive plugin installs", async () => {
    setTty(true);
    primeSuccessfulPluginPersistence("demo");
    installPluginFromNpmSpecMock.mockResolvedValue(createNpmPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:demo"]);

    expect(npmInstallCall().onInstallPolicyWarning).toEqual(expect.any(Function));
  });

  it("reports npm install failures without trying ClawHub when npm: prefix is used", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "npm install failed",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
      code: "missing_openclaw_hooks",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:demo"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("npm install failed");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("keeps actionable hook-pack fallback details", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "npm install failed",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "HOOK.md missing in /tmp/demo-hook",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:demo-hook"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain("npm install failed");
    expect(runtimeErrors.at(-1)).toContain(
      "Also not a valid hook pack: HOOK.md missing in /tmp/demo-hook",
    );
  });

  it("adds a Git PATH hint when npm plugin dependency install cannot spawn git", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: [
        "npm install failed:",
        "npm error code ENOENT",
        "npm error syscall spawn git",
        "npm error path git",
      ].join("\n"),
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
      code: "missing_openclaw_hooks",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:@openclaw/whatsapp"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(
      "one of this plugin's npm dependencies is fetched from a git URL",
    );
    expect(runtimeErrors.at(-1)).toContain("winget install --id Git.Git -e");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not resolve npm: prefixed bundled plugin ids through bundled installs", async () => {
    pluginCliConfigMock.mockReturnValue({ plugins: { load: { paths: [] } } } as OpenClawConfig);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "Package not found on npm: memory-lancedb.",
      code: "npm_package_not_found",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
      code: "missing_openclaw_hooks",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:memory-lancedb"]),
    ).rejects.toThrow("__exit__:1");

    expect(npmInstallCall().spec).toBe("memory-lancedb");
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(configWriteMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Package not found on npm: memory-lancedb.");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("rejects empty npm: prefix installs before resolver lookup", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "npm:"]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("Unsupported npm plugin spec: missing package.");
  });

  it("installs directly from git when git: prefix is used", async () => {
    const { enabledCfg } = primeSuccessfulPluginPersistence("demo");
    installPluginFromGitSpecMock.mockResolvedValue(createGitPluginInstallResult("demo"));

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "git:github.com/acme/demo@v1.2.3",
    ]);

    expect(gitInstallCall().spec).toBe("git:github.com/acme/demo@v1.2.3");
    expect(gitInstallCall().mode).toBe("update");
    expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    const record = persistedInstallRecord("demo");
    expect(record.source).toBe("git");
    expect(record.spec).toBe("git:github.com/acme/demo@v1.2.3");
    expect(record.installPath).toBe(cliInstallPath("demo"));
    expect(record.gitUrl).toBe("https://github.com/acme/demo.git");
    expect(record.gitRef).toBe("v1.2.3");
    expect(record.gitCommit).toBe("abc123");
    expect(configWriteMock).toHaveBeenCalledWith(enabledCfg);
  });

  it("rejects --pin for git installs and points at git refs", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);

    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "git:github.com/acme/demo",
        "--pin",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain("openclaw plugins install git:<repo>@<ref> --force");
  });

  it("passes dangerous force unsafe install to marketplace installs", async () => {
    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        "alpha",
        "--marketplace",
        "local/repo",
        "--dangerously-force-unsafe-install",
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(marketplaceInstallCall().marketplace).toBe("local/repo");
    expect(marketplaceInstallCall().plugin).toBe("alpha");
    expect(marketplaceInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("passes dangerous force unsafe install to npm installs", async () => {
    primeNpmPluginFallback();

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "demo",
      "--dangerously-force-unsafe-install",
    ]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("passes dangerous force unsafe install to linked path probe installs", async () => {
    const cfg = {
      plugins: {
        entries: {},
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-link-"));
    createColdPluginFixture({ rootDir: tmpRoot, pluginId: "demo", packageVersion: "1.2.3" });

    pluginCliConfigMock.mockReturnValue(cfg);
    installPluginFromPathMock.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo",
      targetDir: tmpRoot,
      version: "1.2.3",
      extensions: ["./index.cjs"],
    });
    enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
    recordPluginInstallMock.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(pathInstallCall().path).toBe(tmpRoot);
    expect(pathInstallCall().mode).toBe("install");
    expect(pathInstallCall().dryRun).toBe(true);
    expect(pathInstallCall().allowSourceTypeScriptEntries).toBe(true);
    expect(pathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("passes dangerous force unsafe install to linked hook-pack probe fallback", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-link-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install probe failed",
    });

    try {
      await runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        tmpRoot,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(hookPathInstallCall().path).toBe(tmpRoot);
    expect(hookPathInstallCall().dryRun).toBe(true);
    expect(hookPathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("does not fall back to hook pack for linked path when a no-flag security scan blocks", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-plugin-"));
    const pluginInstallError = "plugin blocked by security scan";

    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: pluginInstallError,
      code: "security_scan_blocked",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPluginDir, "--link"]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(pluginInstallError);
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes dangerous force unsafe install to local hook-pack fallback installs", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-install-"));
    primeHookPackPathFallback({
      tmpRoot,
      pluginInstallError: "plugin install failed",
    });

    try {
      await runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        tmpRoot,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(hookPathInstallCall().path).toBe(tmpRoot);
    expect(hookPathInstallCall().mode).toBe("update");
    expect(hookPathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
  });

  it("passes the active profile extensions dir to local path installs", async () => {
    const extensionsDir = useProfileExtensionsDir();
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    primeSuccessfulPluginPersistence("demo");
    installPluginFromPathMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: path.join(extensionsDir, "demo"),
      version: "1.2.3",
      extensions: ["./dist/index.js"],
    });
    try {
      await runAcknowledgedPluginsInstallCommand(["plugins", "install", localPluginDir]);
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(pathInstallCall().extensionsDir).toBe(extensionsDir);
    expect(pathInstallCall().path).toBe(localPluginDir);
  });
  it("passes force through as overwrite mode for npm installs", async () => {
    primeNpmPluginFallback();

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "demo", "--force"]);

    expect(npmInstallCall().spec).toBe("demo");
    expect(npmInstallCall().mode).toBe("update");
  });

  it("suggests update or --force when npm plugin install target already exists", async () => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    mockClawHubPackageNotFound("@example/lossless-claw");
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error:
        "plugin already exists: /home/openclaw/.openclaw/extensions/lossless-claw (delete it first)",
    });
    installHooksFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    await expect(
      runAcknowledgedPluginsInstallCommand(["plugins", "install", "@example/lossless-claw"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.at(-1)).toContain(
      "Use `openclaw plugins update <id-or-npm-spec>` to upgrade the tracked plugin, or rerun install with `--force` to replace it.",
    );
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("does not append hook-pack fallback details for managed extensions boundary failures", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));

    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: "Invalid path: must stay within extensions directory",
    });
    installHooksFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.hooks",
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand(["plugins", "install", localPluginDir]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(runtimeErrors.at(-1)).toBe("Invalid path: must stay within extensions directory");
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("passes the install logger to the --link dry-run probe", async () => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-link-plugin-"));
    createColdPluginFixture({ rootDir: localPluginDir, pluginId: "demo" });
    const cfg = {
      plugins: {
        entries: {},
        load: {
          paths: [],
        },
      },
    } as OpenClawConfig;
    const enabledCfg = createEnabledPluginConfig("demo");

    pluginCliConfigMock.mockReturnValue(cfg);
    installPluginFromPathMock.mockImplementation(async (...args: unknown[]) => {
      const [params] = args as [
        {
          logger?: { warn?: (message: string) => void };
          path: string;
          dryRun?: boolean;
          dangerouslyForceUnsafeInstall?: boolean;
        },
      ];
      params.logger?.warn?.("WARNING: installer warning from dry-run probe");
      return {
        ok: true,
        pluginId: "demo",
        targetDir: localPluginDir,
        version: "1.0.0",
        extensions: ["./index.cjs"],
      };
    });
    enablePluginInConfigMock.mockReturnValue({ config: enabledCfg });
    recordPluginInstallMock.mockReturnValue(enabledCfg);
    applyExclusiveSlotSelectionMock.mockReturnValue({
      config: enabledCfg,
      warnings: [],
    });

    try {
      await runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        localPluginDir,
        "--link",
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(pathInstallCall().path).toBe(localPluginDir);
    expect(pathInstallCall().dryRun).toBe(true);
    expect(pathInstallCall().allowSourceTypeScriptEntries).toBe(true);
    expect(pathInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
    expect(typeof pathInstallCall().logger?.info).toBe("function");
    expect(typeof pathInstallCall().logger?.warn).toBe("function");
    expect(runtimeLogsContain("installer warning from dry-run probe")).toBe(true);
  });

  it.each([
    {
      name: "a no-flag security scan fails",
      code: "security_scan_failed",
      error: "plugin security scan failed",
      flags: [],
    },
    {
      name: "dangerous force unsafe install is set",
      code: "security_scan_blocked",
      error: "plugin blocked by security scan",
      flags: ["--dangerously-force-unsafe-install"],
    },
    {
      name: "security scan fails under dangerous force unsafe install",
      code: "security_scan_failed",
      error: "plugin security scan failed",
      flags: ["--dangerously-force-unsafe-install"],
    },
  ] as const)("does not fall back to hook pack for local path when $name", async (testCase) => {
    const localPluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-plugin-"));
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: testCase.error,
      code: testCase.code,
    });

    try {
      await expect(
        runAcknowledgedPluginsInstallCommand([
          "plugins",
          "install",
          localPluginDir,
          ...testCase.flags,
        ]),
      ).rejects.toThrow("__exit__:1");
    } finally {
      fs.rmSync(localPluginDir, { recursive: true, force: true });
    }

    expect(installHooksFromPathMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(testCase.error);
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it.each([
    {
      name: "dangerous force unsafe install is set",
      code: "security_scan_blocked",
      error: "plugin blocked by security scan",
      spec: "demo",
      flags: ["--dangerously-force-unsafe-install"],
    },
    {
      name: "a no-flag security scan blocks",
      code: "security_scan_blocked",
      error:
        'Plugin "unsafe-plugin" installation blocked: dangerous code patterns detected: finding details',
      spec: "@acme/unsafe-plugin",
      flags: [],
    },
    {
      name: "security scan fails under dangerous force unsafe install",
      code: "security_scan_failed",
      error: "plugin security scan failed",
      spec: "demo",
      flags: ["--dangerously-force-unsafe-install"],
    },
  ] as const)("does not fall back to hook pack for npm installs when $name", async (testCase) => {
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    mockClawHubPackageNotFound(testCase.spec);
    installPluginFromNpmSpecMock.mockResolvedValue({
      ok: false,
      error: testCase.error,
      code: testCase.code,
    });

    await expect(
      runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        testCase.spec,
        ...testCase.flags,
      ]),
    ).rejects.toThrow("__exit__:1");

    expect(installHooksFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain(testCase.error);
    expect(runtimeErrors.at(-1)).not.toContain("Also not a valid hook pack");
  });

  it("still falls back to local hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    const localHookDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-hook-pack-"));
    pluginCliConfigMock.mockReturnValue({} as OpenClawConfig);
    installPluginFromPathMock.mockResolvedValue({
      ok: false,
      error: "package.json missing openclaw.plugin.json",
      code: "missing_openclaw_extensions",
    });
    installHooksFromPathMock.mockResolvedValue({
      ok: true,
      hookPackId: "demo-hooks",
      hooks: ["command-audit"],
      targetDir: "/tmp/hooks/demo-hooks",
      version: "1.2.3",
    });
    recordHookInstallMock.mockReturnValue(createPathHookPackInstalledConfig(localHookDir));

    try {
      await runAcknowledgedPluginsInstallCommand([
        "plugins",
        "install",
        localHookDir,
        "--dangerously-force-unsafe-install",
      ]);
    } finally {
      fs.rmSync(localHookDir, { recursive: true, force: true });
    }

    expect(hookPathInstallCall().path).toBe(localHookDir);
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
  });

  it("still falls back to npm hook pack when dangerous force unsafe install is set for non-security errors", async () => {
    primeHookPackNpmFallback();

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "@acme/demo-hooks",
      "--dangerously-force-unsafe-install",
    ]);

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    expect(hookNpmInstallCall().dangerouslyForceUnsafeInstall).toBe(true);
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
  });

  it("does not fall back to npm when explicit ClawHub rejects a real package", async () => {
    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    installPluginFromClawHubMock.mockResolvedValue({
      ok: false,
      error: 'Use "openclaw skills install demo" instead.',
      code: "skill_package",
    });

    await expect(runPluginsCommand(["plugins", "install", "clawhub:demo"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
    expect(runtimeErrors.at(-1)).toContain('Use "openclaw skills install demo" instead.');
  });

  it("falls back to installing hook packs from npm specs", async () => {
    const { installedCfg } = primeHookPackNpmFallback();

    await runAcknowledgedPluginsInstallCommand(["plugins", "install", "@acme/demo-hooks"]);

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    const record = recordHookInstallCall();
    expect(record.hookId).toBe("demo-hooks");
    expect(record.spec).toBe("@acme/demo-hooks");
    expect(record.resolvedVersion).toBe("1.2.3");
    expect(record.resolvedSpec).toBe("@acme/demo-hooks@1.2.3");
    expect(record.integrity).toBe("sha256-demo");
    expect(record.hooks).toEqual(["command-audit"]);
    expect(configWriteMock).toHaveBeenCalledWith(installedCfg);
    expect(runtimeLogsContain("Installed hook pack: demo-hooks")).toBe(true);
  });

  it("passes force through as overwrite mode for hook-pack npm fallback installs", async () => {
    primeHookPackNpmFallback();

    await runAcknowledgedPluginsInstallCommand([
      "plugins",
      "install",
      "@acme/demo-hooks",
      "--force",
    ]);

    expect(hookNpmInstallCall().spec).toBe("@acme/demo-hooks");
    expect(hookNpmInstallCall().mode).toBe("update");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
