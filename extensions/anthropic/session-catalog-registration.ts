import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLazyRuntimeModule,
  createLazyRuntimeSurface,
} from "openclaw/plugin-sdk/lazy-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeHostCommand,
  OpenClawPluginNodeInvokePolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { CLAUDE_CLI_BACKEND_ID, CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS } from "./cli-constants.js";
import { resolveClaudeTerminalExecutable } from "./session-catalog-executable.js";
import {
  CLAUDE_CLI_NODE_RUN_COMMAND,
  CLAUDE_SESSION_READ_COMMAND,
  CLAUDE_SESSIONS_LIST_COMMAND,
  CLAUDE_TERMINAL_RESUME_COMMAND,
} from "./session-catalog-shared.js";

const CLAUDE_SESSIONS_CAPABILITY = "claude-sessions";

const loadClaudeSessionNodeCommands = createLazyRuntimeModule(
  () => import("./session-catalog-node-commands.js"),
);

function isClaudeSessionCatalogEnabled(pluginConfig: unknown): boolean {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return true;
  }
  const sessionCatalog = (pluginConfig as { sessionCatalog?: unknown }).sessionCatalog;
  return !(
    sessionCatalog &&
    typeof sessionCatalog === "object" &&
    (sessionCatalog as { enabled?: unknown }).enabled === false
  );
}

// Node declarations expose catalog commands only when this machine owns a
// Claude session store; otherwise the gateway must skip the node capability.
function claudeProjectsAvailable(env: NodeJS.ProcessEnv): boolean {
  const homeDir = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  try {
    return statSync(path.join(homeDir, ".claude", "projects")).isDirectory();
  } catch {
    return false;
  }
}

function currentConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config ?? {}) as OpenClawConfig;
}

function registerClaudeSessionCatalog(api: OpenClawPluginApi): void {
  const loadCatalogRuntime = createLazyRuntimeSurface(
    () => import("./session-catalog.js"),
    (module) => module.createClaudeSessionCatalogRuntime(api),
  );
  const provider: SessionCatalogProvider = {
    id: "claude",
    label: "Claude Code",
    resolveCreateSession: ({ agentId }) =>
      api.runtime.agent.resolveSessionCatalogCreateTarget({
        config: currentConfig(api),
        requestedAgentId: agentId,
        provider: "anthropic",
        modelIds: CLAUDE_CLI_ROUTE_PROBE_MODEL_IDS,
        agentRuntime: CLAUDE_CLI_BACKEND_ID,
      }),
    list: async (query) => await (await loadCatalogRuntime()).list(query),
    read: async (request) => await (await loadCatalogRuntime()).read(request),
    continueSession: async (request) => await (await loadCatalogRuntime()).continueSession(request),
    startTerminalSession: async (request) =>
      await (await loadCatalogRuntime()).startTerminalSession(request),
    openTerminal: async (request) => await (await loadCatalogRuntime()).openTerminal(request),
    checkUpstreamActivity: async (probes) =>
      await (await loadCatalogRuntime()).checkUpstreamActivity(probes),
  };
  api.registerSessionCatalog(provider);
}

function createClaudeSessionNodeHostCommands(): OpenClawPluginNodeHostCommand[] {
  return [
    {
      command: CLAUDE_SESSIONS_LIST_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        await (await loadClaudeSessionNodeCommands()).listClaudeSessions(paramsJSON),
    },
    {
      command: CLAUDE_SESSION_READ_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      isAvailable: ({ env }) => claudeProjectsAvailable(env),
      handle: async (paramsJSON) =>
        await (await loadClaudeSessionNodeCommands()).readClaudeSession(paramsJSON),
    },
    {
      command: CLAUDE_TERMINAL_RESUME_COMMAND,
      cap: CLAUDE_SESSIONS_CAPABILITY,
      dangerous: false,
      duplex: true,
      isAvailable: ({ env }) =>
        claudeProjectsAvailable(env) && Boolean(resolveClaudeTerminalExecutable(env)),
      handle: async (paramsJSON, io) =>
        await (await loadClaudeSessionNodeCommands()).resumeClaudeSession(paramsJSON, io),
    },
  ];
}

export function createClaudeSessionNodeInvokePolicies(): OpenClawPluginNodeInvokePolicy[] {
  return [
    {
      commands: [
        CLAUDE_SESSIONS_LIST_COMMAND,
        CLAUDE_SESSION_READ_COMMAND,
        CLAUDE_CLI_NODE_RUN_COMMAND,
        CLAUDE_TERMINAL_RESUME_COMMAND,
      ],
      defaultPlatforms: ["macos", "linux", "windows"],
      handle: (context) =>
        context.command === CLAUDE_TERMINAL_RESUME_COMMAND ? { ok: true } : context.invokeNode(),
    },
  ];
}

export function registerClaudeSessionDiscovery(api: OpenClawPluginApi): void {
  if (!isClaudeSessionCatalogEnabled(api.pluginConfig)) {
    return;
  }
  registerClaudeSessionCatalog(api);
  for (const command of createClaudeSessionNodeHostCommands()) {
    api.registerNodeHostCommand(command);
  }
}
