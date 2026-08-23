/**
 * Minimal setup command.
 *
 * Ensures config, default workspace, and session directories exist without
 * running the full onboarding wizard.
 */
import fs from "node:fs/promises";
import {
  listAgentEntries,
  resolveAgentEntry,
  resolveDefaultAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  configIncludeOwnsAgentRoster,
  hasResolvedRosterBeforeMigrations,
} from "../config/agent-roster-provenance.js";
import type { ConfigWriteOptions, ReadConfigFileSnapshotForWriteResult } from "../config/io.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime, writeRuntimeJson } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { shortenHomePath } from "../utils.js";

type ConfigIO = {
  configPath: string;
  readConfigFileSnapshotForWrite: () => Promise<ReadConfigFileSnapshotForWriteResult>;
};

type ReplaceConfigFile = (params: {
  nextConfig: OpenClawConfig;
  snapshot: ConfigFileSnapshot;
  afterWrite: { mode: "auto" };
  writeOptions: ConfigWriteOptions;
}) => Promise<unknown>;

type EnsureAgentWorkspace = (params: {
  dir: string;
  ensureBootstrapFiles?: boolean;
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
}) => Promise<{ dir: string }>;

type SetupCommandDeps = {
  createConfigIO?: () => ConfigIO;
  defaultAgentWorkspaceDir?: string | (() => string | Promise<string>);
  ensureAgentWorkspace?: EnsureAgentWorkspace;
  formatConfigFilePath?: (path: string) => string;
  logConfigUpdated?: (
    runtime: RuntimeEnv,
    opts: { path?: string; suffix?: string },
  ) => void | Promise<void>;
  mkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>;
  resolveSessionTranscriptsDir?: (agentId: string) => string | Promise<string>;
  replaceConfigFile?: ReplaceConfigFile;
};

type AgentWorkspaceModule = typeof import("../agents/workspace.js");
type ConfigIOModule = typeof import("../config/config.js");
type ConfigLoggingModule = typeof import("../config/logging.js");

const agentWorkspaceModuleLoader = createLazyImportLoader<AgentWorkspaceModule>(
  () => import("../agents/workspace.js"),
);
const configIOModuleLoader = createLazyImportLoader<ConfigIOModule>(
  () => import("../config/config.js"),
);
const configLoggingModuleLoader = createLazyImportLoader<ConfigLoggingModule>(
  () => import("../config/logging.js"),
);

// Keep setup's cold path small; config/workspace modules are loaded only when
// their default dependency is actually needed.
function loadAgentWorkspaceModule(): Promise<AgentWorkspaceModule> {
  return agentWorkspaceModuleLoader.load();
}

function loadConfigIOModule(): Promise<ConfigIOModule> {
  return configIOModuleLoader.load();
}

function loadConfigLoggingModule(): Promise<ConfigLoggingModule> {
  return configLoggingModuleLoader.load();
}

async function createDefaultConfigIO(): Promise<ConfigIO> {
  const { createConfigIO } = await loadConfigIOModule();
  return createConfigIO();
}

async function resolveDefaultAgentWorkspaceDir(deps: SetupCommandDeps): Promise<string> {
  const override = deps.defaultAgentWorkspaceDir;
  if (typeof override === "string") {
    return override;
  }
  if (typeof override === "function") {
    return await override();
  }
  const { DEFAULT_AGENT_WORKSPACE_DIR } = await loadAgentWorkspaceModule();
  return DEFAULT_AGENT_WORKSPACE_DIR;
}

async function ensureDefaultAgentWorkspace(
  params: Parameters<EnsureAgentWorkspace>[0],
): ReturnType<EnsureAgentWorkspace> {
  const { ensureAgentWorkspace } = await loadAgentWorkspaceModule();
  return ensureAgentWorkspace(params);
}

async function writeDefaultConfigFile(params: Parameters<ReplaceConfigFile>[0]): Promise<void> {
  const { replaceConfigFile } = await loadConfigIOModule();
  await replaceConfigFile(params);
}

async function formatDefaultConfigPath(configPath: string): Promise<string> {
  const { formatConfigFilePath } = await loadConfigLoggingModule();
  return formatConfigFilePath(configPath);
}

async function logDefaultConfigUpdated(
  runtime: RuntimeEnv,
  opts: { path?: string; suffix?: string },
): Promise<void> {
  const { logConfigUpdated } = await loadConfigLoggingModule();
  logConfigUpdated(runtime, opts);
}

async function resolveDefaultSessionTranscriptsDir(agentId: string): Promise<string> {
  const { resolveSessionTranscriptsDirForAgent } = await import("../config/sessions.js");
  return resolveSessionTranscriptsDirForAgent(agentId);
}

/** Prepares config, workspace, and session directories for a usable installation. */
export async function setupCommand(
  opts?: { workspace?: string; json?: boolean },
  runtime: RuntimeEnv = defaultRuntime,
  deps: SetupCommandDeps = {},
) {
  const desiredWorkspace =
    typeof opts?.workspace === "string" && opts.workspace.trim()
      ? opts.workspace.trim()
      : undefined;

  const io = deps.createConfigIO?.() ?? (await createDefaultConfigIO());
  const configPath = io.configPath;
  const prepared = await io.readConfigFileSnapshotForWrite();
  const snapshot = prepared.snapshot;
  if (snapshot.exists && !snapshot.valid) {
    const formatConfigFilePath = deps.formatConfigFilePath ?? formatDefaultConfigPath;
    runtime.error(
      `Config invalid at ${await formatConfigFilePath(configPath)}. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const resolvedConfig = snapshot.config;
  const shouldPersistRoster =
    !snapshot.exists ||
    (!hasResolvedRosterBeforeMigrations(snapshot) && !configIncludeOwnsAgentRoster(snapshot));
  const cfg = shouldPersistRoster
    ? (migratePersistedImplicitMainRoster(snapshot.sourceConfig).config as OpenClawConfig)
    : snapshot.sourceConfig;
  const authoredDefaults = cfg.agents?.defaults ?? {};
  const resolvedDefaults = resolvedConfig.agents?.defaults ?? authoredDefaults;
  const defaultEntry = resolveAgentEntry(resolvedConfig, resolveDefaultAgentId(resolvedConfig));
  const defaultEntryWorkspace = defaultEntry?.workspace?.trim();
  const configuredWorkspace = defaultEntryWorkspace || resolvedDefaults.workspace;

  const workspace =
    desiredWorkspace ?? configuredWorkspace ?? (await resolveDefaultAgentWorkspaceDir(deps));
  // Bare setup is observational for an established roster. Only a caller
  // override or fresh bootstrap owns a persisted workspace change.
  const shouldWriteWorkspace =
    !snapshot.exists || (desiredWorkspace !== undefined && configuredWorkspace !== workspace);
  const shouldWriteGatewayMode = resolvedConfig.gateway?.mode === undefined;
  const writeInheritedWorkspaceOverride =
    snapshot.exists &&
    shouldWriteWorkspace &&
    !defaultEntryWorkspace &&
    configIncludeOwnsAgentRoster(snapshot);

  // Keep the candidate runtime-shaped. replaceConfigFile persists only its
  // diff against snapshot.parsed, never resolved include/env values wholesale.
  let next: OpenClawConfig = snapshot.exists ? resolvedConfig : cfg;
  if (shouldPersistRoster) {
    const { list: _legacyList, ...agents } = next.agents ?? {};
    next = {
      ...next,
      agents: { ...agents, entries: toAgentEntriesRecord(listAgentEntries(cfg)) },
    };
  }
  if (shouldWriteWorkspace) {
    if (!writeInheritedWorkspaceOverride) {
      const roster = structuredClone(listAgentEntries(next));
      if (!snapshot.exists || Boolean(defaultEntryWorkspace)) {
        for (const entry of roster) {
          if (entry.default === true) {
            // Fresh bootstrap and explicitly entry-owned workspaces stay aligned.
            // Inherited defaults must not turn an include-owned roster into a roster write.
            entry.workspace = workspace;
          }
        }
      }
      const entries = roster.length > 0 ? toAgentEntriesRecord(roster) : undefined;
      const { list: _legacyList, ...agents } = next.agents ?? {};
      next = {
        ...next,
        agents: {
          ...agents,
          defaults: { ...agents.defaults, workspace },
          ...(entries ? { entries } : {}),
        },
      };
    }
  }
  if (shouldWriteGatewayMode) {
    next = { ...next, gateway: { ...next.gateway, mode: "local" } };
  }

  if (!snapshot.exists) {
    const { ensureOnboardingAgent } = await import("./onboard-agent.js");
    next = (await ensureOnboardingAgent({ config: next, workspace, baseConfig: cfg })).config;
  }

  const configChanged =
    !snapshot.exists || shouldPersistRoster || shouldWriteWorkspace || shouldWriteGatewayMode;
  let configStatus: "created" | "updated" | "unchanged";
  if (configChanged) {
    // Preserve all existing config fields and touch only workspace/gateway mode
    // defaults that this command owns.
    const replaceConfig = deps.replaceConfigFile ?? writeDefaultConfigFile;
    await replaceConfig({
      nextConfig: next,
      snapshot,
      afterWrite: { mode: "auto" },
      writeOptions: {
        ...prepared.writeOptions,
        ...(snapshot.exists && shouldPersistRoster
          ? {
              explicitSetPaths: [["agents", "entries"]],
              explicitSetValueSource: cfg,
            }
          : {}),
        ...(writeInheritedWorkspaceOverride
          ? {
              allowIncludeAncestorExplicitSetPaths: true,
              explicitSetPaths: [["agents", "defaults", "workspace"]],
              explicitSetValueSource: { agents: { defaults: { workspace } } },
            }
          : {}),
      },
    });
    configStatus = snapshot.exists ? "updated" : "created";
    if (!opts?.json && !snapshot.exists) {
      const formatConfigFilePath = deps.formatConfigFilePath ?? formatDefaultConfigPath;
      runtime.log(`Wrote ${await formatConfigFilePath(configPath)}`);
    } else if (!opts?.json) {
      const updates: string[] = [];
      if (shouldWriteWorkspace) {
        updates.push("set agents.defaults.workspace");
      }
      if (shouldWriteGatewayMode) {
        updates.push("set gateway.mode");
      }
      const suffix = updates.length > 0 ? `(${updates.join(", ")})` : undefined;
      await (deps.logConfigUpdated ?? logDefaultConfigUpdated)(runtime, {
        path: configPath,
        suffix,
      });
    }
  } else {
    configStatus = "unchanged";
    if (!opts?.json) {
      const formatConfigFilePath = deps.formatConfigFilePath ?? formatDefaultConfigPath;
      runtime.log(`Config OK: ${await formatConfigFilePath(configPath)}`);
    }
  }

  const ws = await (deps.ensureAgentWorkspace ?? ensureDefaultAgentWorkspace)({
    dir: workspace,
    ensureBootstrapFiles: !resolvedDefaults.skipBootstrap,
    skipOptionalBootstrapFiles: resolvedDefaults.skipOptionalBootstrapFiles,
  });
  if (!opts?.json) {
    runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);
  }

  const defaultAgentId = resolveDefaultAgentId(next);
  const sessionsDir = await (
    deps.resolveSessionTranscriptsDir ?? resolveDefaultSessionTranscriptsDir
  )(defaultAgentId);
  await (deps.mkdir ?? fs.mkdir)(sessionsDir, { recursive: true });
  if (opts?.json) {
    writeRuntimeJson(runtime, {
      ok: true,
      configPath,
      configStatus,
      workspaceDir: ws.dir,
      sessionsDir,
    });
    return;
  }
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
  runtime.log("");
  runtime.log("Setup complete: config, workspace, and session directories are ready.");
  runtime.log(`Next guided path: ${formatCliCommand("openclaw onboard")}.`);
  runtime.log(
    `Next targeted changes: ${formatCliCommand("openclaw configure")} for models, channels, Gateway, plugins, skills, and health checks.`,
  );
  runtime.log(`Add a chat channel later: ${formatCliCommand("openclaw channels add")}.`);
}
