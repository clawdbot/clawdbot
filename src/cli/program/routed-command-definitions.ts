import { defaultRuntime } from "../../runtime.js";
import {
  parseAgentsListRouteArgs,
  parseChannelsListRouteArgs,
  parseChannelsStatusRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

type RouteArgParser<TArgs> = (argv: string[]) => TArgs | null;

type ParsedRouteArgs<TParse extends RouteArgParser<unknown>> = Exclude<ReturnType<TParse>, null>;
type ConfigCliModule = typeof import("../config-cli.js");
type ModelsListCommandModule = typeof import("../../commands/models/list.list-command.js");
type ModelsStatusCommandModule = typeof import("../../commands/models/list.status-command.js");

export type RoutedCommandDefinition<TParse extends RouteArgParser<unknown>> = {
  parseArgs: TParse;
  runParsedArgs: (args: ParsedRouteArgs<TParse>) => Promise<void>;
};

export type AnyRoutedCommandDefinition = {
  parseArgs: RouteArgParser<unknown>;
  runParsedArgs: (args: never) => Promise<void>;
};

function defineRoutedCommand<TParse extends RouteArgParser<unknown>>(
  definition: RoutedCommandDefinition<TParse>,
): RoutedCommandDefinition<TParse> {
  return definition;
}

let configCliPromise: Promise<ConfigCliModule> | undefined;
let modelsListCommandPromise: Promise<ModelsListCommandModule> | undefined;
let modelsStatusCommandPromise: Promise<ModelsStatusCommandModule> | undefined;

function loadConfigCli(): Promise<ConfigCliModule> {
  configCliPromise ??= import("../config-cli.js");
  return configCliPromise;
}

function loadModelsListCommand(): Promise<ModelsListCommandModule> {
  modelsListCommandPromise ??= import("../../commands/models/list.list-command.js");
  return modelsListCommandPromise;
}

function loadModelsStatusCommand(): Promise<ModelsStatusCommandModule> {
  modelsStatusCommandPromise ??= import("../../commands/models/list.status-command.js");
  return modelsStatusCommandPromise;
}

export const routedCommandDefinitions = {
  health: defineRoutedCommand({
    parseArgs: parseHealthRouteArgs,
    runParsedArgs: async (args) => {
      const { healthCommand } = await import("../../commands/health.js");
      await healthCommand(args, defaultRuntime);
    },
  }),
  status: defineRoutedCommand({
    parseArgs: parseStatusRouteArgs,
    runParsedArgs: async (args) => {
      if (args.json) {
        const { statusJsonCommand } = await import("../../commands/status-json.js");
        await statusJsonCommand(
          {
            deep: args.deep,
            all: args.all,
            usage: args.usage,
            timeoutMs: args.timeoutMs,
          },
          defaultRuntime,
        );
        return;
      }
      const { statusCommand } = await import("../../commands/status.js");
      await statusCommand(args, defaultRuntime);
    },
  }),
  "gateway-status": defineRoutedCommand({
    parseArgs: parseGatewayStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { runDaemonStatus } = await import("../daemon-cli/status.js");
      await runDaemonStatus(args);
    },
  }),
  sessions: defineRoutedCommand({
    parseArgs: parseSessionsRouteArgs,
    runParsedArgs: async (args) => {
      const { sessionsCommand } = await import("../../commands/sessions.js");
      await sessionsCommand(args, defaultRuntime);
    },
  }),
  "agents-list": defineRoutedCommand({
    parseArgs: parseAgentsListRouteArgs,
    runParsedArgs: async (args) => {
      const { agentsListCommand } = await import("../../commands/agents.js");
      await agentsListCommand(args, defaultRuntime);
    },
  }),
  "config-get": defineRoutedCommand({
    parseArgs: parseConfigGetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigGet } = await loadConfigCli();
      await runConfigGet(args);
    },
  }),
  "config-unset": defineRoutedCommand({
    parseArgs: parseConfigUnsetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigUnset } = await loadConfigCli();
      await runConfigUnset(args);
    },
  }),
  "models-list": defineRoutedCommand({
    parseArgs: parseModelsListRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsListCommand } = await loadModelsListCommand();
      await modelsListCommand(args, defaultRuntime);
    },
  }),
  "models-status": defineRoutedCommand({
    parseArgs: parseModelsStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsStatusCommand } = await loadModelsStatusCommand();
      await modelsStatusCommand(args, defaultRuntime);
    },
  }),
  "channels-list": defineRoutedCommand({
    parseArgs: parseChannelsListRouteArgs,
    runParsedArgs: async (args) => {
      const { channelsListCommand } = await import("../../commands/channels/list.js");
      await channelsListCommand(args, defaultRuntime);
    },
  }),
  "channels-status": defineRoutedCommand({
    parseArgs: parseChannelsStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { channelsStatusCommand } = await import("../../commands/channels/status.js");
      await channelsStatusCommand(args, defaultRuntime);
    },
  }),
};
