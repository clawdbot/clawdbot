/**
 * Minimal setup command.
 *
 * Ensures config, default workspace, and session directories exist without
 * running the full onboarding wizard.
 */
import fs from "node:fs/promises";
import { formatCliCommand } from "../cli/command-format.js";
import type { ConfigWriteOptions, ReadConfigFileSnapshotForWriteResult } from "../config/io.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
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
  formatConfigPath?: (path: string) => string;
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
  const { formatConfigPath } = await loadConfigLoggingModule();
  return formatConfigPath(configPath);
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
  opts?: { workspace?: string },
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
    const formatConfigPath = deps.formatConfigPath ?? formatDefaultConfigPath;
    runtime.error(
      `Config invalid at ${await formatConfigPath(configPath)}. Run \`${formatCliCommand("openclaw doctor")}\` to repair it, then re-run setup.`,
    );
    runtime.exit(1);
    return;
  }

  const cfg = snapshot.sourceConfig;
  const defaults = cfg.agents?.defaults ?? {};

  const workspace =
    desiredWorkspace ?? defaults.workspace ?? (await resolveDefaultAgentWorkspaceDir(deps));

  const next: OpenClawConfig = {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
    gateway: {
      ...cfg.gateway,
      mode: cfg.gateway?.mode ?? "local",
    },
  };

  if (
    !snapshot.exists ||
    defaults.workspace !== workspace ||
    cfg.gateway?.mode !== next.gateway?.mode
  ) {
    // Preserve all existing config fields and touch only workspace/gateway mode
    // defaults that this command owns.
    const replaceConfig = deps.replaceConfigFile ?? writeDefaultConfigFile;
    await replaceConfig({
      nextConfig: next,
      snapshot,
      afterWrite: { mode: "auto" },
      writeOptions: prepared.writeOptions,
    });
    if (!snapshot.exists) {
      const formatConfigPath = deps.formatConfigPath ?? formatDefaultConfigPath;
      runtime.log(`Wrote ${await formatConfigPath(configPath)}`);
    } else {
      const updates: string[] = [];
      if (defaults.workspace !== workspace) {
        updates.push("set agents.defaults.workspace");
      }
      if (cfg.gateway?.mode !== next.gateway?.mode) {
        updates.push("set gateway.mode");
      }
      const suffix = updates.length > 0 ? `(${updates.join(", ")})` : undefined;
      await (deps.logConfigUpdated ?? logDefaultConfigUpdated)(runtime, {
        path: configPath,
        suffix,
      });
    }
  } else {
    const formatConfigPath = deps.formatConfigPath ?? formatDefaultConfigPath;
    runtime.log(`Config OK: ${await formatConfigPath(configPath)}`);
  }

  const ws = await (deps.ensureAgentWorkspace ?? ensureDefaultAgentWorkspace)({
    dir: workspace,
    ensureBootstrapFiles: !next.agents?.defaults?.skipBootstrap,
    skipOptionalBootstrapFiles: next.agents?.defaults?.skipOptionalBootstrapFiles,
  });
  runtime.log(`Workspace OK: ${shortenHomePath(ws.dir)}`);

  const { resolveDefaultAgentId } = await import("../agents/agent-scope.js");
  const sessionsDir = await (
    deps.resolveSessionTranscriptsDir ?? resolveDefaultSessionTranscriptsDir
  )(resolveDefaultAgentId(next));
  await (deps.mkdir ?? fs.mkdir)(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
  runtime.log("");
  runtime.log("Setup complete: config, workspace, and session directories are ready.");
  runtime.log(`Next guided path: ${formatCliCommand("openclaw onboard")}.`);
  runtime.log(
    `Next targeted changes: ${formatCliCommand("openclaw configure")} for models, channels, Gateway, plugins, skills, and health checks.`,
  );
  runtime.log(`Add a chat channel later: ${formatCliCommand("openclaw channels add")}.`);
}
