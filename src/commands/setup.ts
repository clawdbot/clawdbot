import fs from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import { formatCliCommand } from "../cli/command-format.js";
import type { OptionalBootstrapFileName } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { shortenHomePath } from "../utils.js";
import { safeParseWithSchema } from "../utils/zod-parse.js";

const JsonRecordSchema = z.record(z.string(), z.unknown());

type ConfigIO = {
  configPath: string;
};

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
  resolveSessionTranscriptsDir?: () => string | Promise<string>;
  replaceConfigFile?: (params: {
    nextConfig: OpenClawConfig;
    afterWrite: { mode: "auto" };
  }) => Promise<unknown>;
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

async function writeDefaultConfigFile(config: OpenClawConfig): Promise<void> {
  const { replaceConfigFile } = await loadConfigIOModule();
  await replaceConfigFile({
    nextConfig: config,
    afterWrite: { mode: "auto" },
  });
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

async function resolveDefaultSessionTranscriptsDir(): Promise<string> {
  const { resolveSessionTranscriptsDir } = await import("../config/sessions.js");
  return resolveSessionTranscriptsDir();
}

async function readConfigFileRaw(configPath: string): Promise<{
  exists: boolean;
  parsed: OpenClawConfig;
}> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = safeParseWithSchema(JsonRecordSchema, JSON5.parse(raw));
    return { exists: true, parsed: (parsed ?? {}) as OpenClawConfig };
  } catch {
    return { exists: false, parsed: {} };
  }
}

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
  const existingRaw = await readConfigFileRaw(configPath);
  const cfg = existingRaw.parsed;
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
    !existingRaw.exists ||
    defaults.workspace !== workspace ||
    cfg.gateway?.mode !== next.gateway?.mode
  ) {
    const replaceConfig =
      deps.replaceConfigFile ?? ((params) => writeDefaultConfigFile(params.nextConfig));
    await replaceConfig({
      nextConfig: next,
      afterWrite: { mode: "auto" },
    });
    if (!existingRaw.exists) {
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

  const sessionsDir = await (
    deps.resolveSessionTranscriptsDir ?? resolveDefaultSessionTranscriptsDir
  )();
  await (deps.mkdir ?? fs.mkdir)(sessionsDir, { recursive: true });
  runtime.log(`Sessions OK: ${shortenHomePath(sessionsDir)}`);
  runtime.log("");
  runtime.log("Setup complete: local config, workspace, and session directories are ready.");
  runtime.log(
    `Next: run ${formatCliCommand("openclaw configure")} to choose models, channels, Gateway, plugins, skills, and health checks.`,
  );
  runtime.log(`For full first-run onboarding, run ${formatCliCommand("openclaw setup --wizard")}.`);
}
