import type { Command } from "commander";

import { agentsListCommand } from "../../commands/agents.js";
import { healthCommand } from "../../commands/health.js";
import { sessionsCommand } from "../../commands/sessions.js";
import { statusCommand } from "../../commands/status.js";
import { defaultRuntime } from "../../runtime.js";
import { getFlagValue, getPositiveIntFlagValue, getVerboseFlag, hasFlag } from "../argv.js";
import { registerBrowserCli } from "../browser-cli.js";
import { registerConfigCli } from "../config-cli.js";
import { registerMemoryCli, runMemoryStatus } from "../memory-cli.js";
import { registerWorkspaceCli } from "../workspace-cli.js";
import { registerAgentCommands } from "./register.agent.js";
import { registerConfigureCommand } from "./register.configure.js";
import { registerMaintenanceCommands } from "./register.maintenance.js";
import { registerMessageCommands } from "./register.message.js";
import { registerOnboardCommand } from "./register.onboard.js";
import { registerSetupCommand } from "./register.setup.js";
import { registerStatusHealthSessionsCommands } from "./register.status-health-sessions.js";
import { registerSubCliCommands } from "./register.subclis.js";
import type { ProgramContext } from "./context.js";

type CommandRegisterParams = {
  program: Command;
  ctx: ProgramContext;
  argv: string[];
};

type RouteSpec = {
  match: (path: string[]) => boolean;
  loadPlugins?: boolean;
  run: (argv: string[]) => Promise<boolean>;
};

export type CommandRegistration = {
  id: string;
  register: (params: CommandRegisterParams) => void;
  routes?: RouteSpec[];
};

const routeHealth: RouteSpec = {
  match: (path) => path[0] === "health",
  loadPlugins: true,
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) return false;
    await healthCommand({ json, timeoutMs, verbose }, defaultRuntime);
    return true;
  },
};

const routeStatus: RouteSpec = {
  match: (path) => path[0] === "status",
  loadPlugins: true,
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const all = hasFlag(argv, "--all");
    const usage = hasFlag(argv, "--usage");
    const verbose = getVerboseFlag(argv, { includeDebug: true });
    const timeoutMs = getPositiveIntFlagValue(argv, "--timeout");
    if (timeoutMs === null) return false;
    await statusCommand({ json, deep, all, usage, timeoutMs, verbose }, defaultRuntime);
    return true;
  },
};

const routeSessions: RouteSpec = {
  match: (path) => path[0] === "sessions",
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const store = getFlagValue(argv, "--store");
    if (store === null) return false;
    const active = getFlagValue(argv, "--active");
    if (active === null) return false;
    await sessionsCommand({ json, store, active }, defaultRuntime);
    return true;
  },
};

const routeAgentsList: RouteSpec = {
  match: (path) => path[0] === "agents" && path[1] === "list",
  run: async (argv) => {
    const json = hasFlag(argv, "--json");
    const bindings = hasFlag(argv, "--bindings");
    await agentsListCommand({ json, bindings }, defaultRuntime);
    return true;
  },
};

const routeMemoryStatus: RouteSpec = {
  match: (path) => path[0] === "memory" && path[1] === "status",
  run: async (argv) => {
    const agent = getFlagValue(argv, "--agent");
    if (agent === null) return false;
    const json = hasFlag(argv, "--json");
    const deep = hasFlag(argv, "--deep");
    const index = hasFlag(argv, "--index");
    const verbose = hasFlag(argv, "--verbose");
    await runMemoryStatus({ agent, json, deep, index, verbose });
    return true;
  },
};

export const commandRegistry: CommandRegistration[] = [
  {
    id: "setup",
    register: ({ program }) => registerSetupCommand(program),
  },
  {
    id: "onboard",
    register: ({ program }) => registerOnboardCommand(program),
  },
  {
    id: "configure",
    register: ({ program }) => registerConfigureCommand(program),
  },
  {
    id: "config",
    register: ({ program }) => registerConfigCli(program),
  },
  {
    id: "maintenance",
    register: ({ program }) => registerMaintenanceCommands(program),
  },
  {
    id: "message",
    register: ({ program, ctx }) => registerMessageCommands(program, ctx),
  },
  {
    id: "memory",
    register: ({ program }) => registerMemoryCli(program),
    routes: [routeMemoryStatus],
  },
  {
    id: "agent",
    register: ({ program, ctx }) =>
      registerAgentCommands(program, { agentChannelOptions: ctx.agentChannelOptions }),
    routes: [routeAgentsList],
  },
  {
    id: "subclis",
    register: ({ program, argv }) => registerSubCliCommands(program, argv),
  },
  {
    id: "status-health-sessions",
    register: ({ program }) => registerStatusHealthSessionsCommands(program),
    routes: [routeHealth, routeStatus, routeSessions],
  },
  {
    id: "browser",
    register: ({ program }) => registerBrowserCli(program),
  },
  {
    id: "workspace",
    register: ({ program }) => registerWorkspaceCli(program),
  },
];

export function registerProgramCommands(
  program: Command,
  ctx: ProgramContext,
  argv: string[] = process.argv,
) {
  for (const entry of commandRegistry) {
    entry.register({ program, ctx, argv });
  }
}

export function findRoutedCommand(path: string[]): RouteSpec | null {
  for (const entry of commandRegistry) {
    if (!entry.routes) continue;
    for (const route of entry.routes) {
      if (route.match(path)) return route;
    }
  }
  return null;
}
