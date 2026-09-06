// Lazy command implementations for routes that can bypass full Commander registration.
import { defaultRuntime } from "../../runtime.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import {
  parseAgentsListRouteArgs,
  parseChannelsListRouteArgs,
  parseChannelsStatusRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayHealthRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parsePluginsListRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
  parseTasksAuditRouteArgs,
  parseTasksListRouteArgs,
} from "./route-args.js";

type RouteArgParser<TArgs> = (argv: string[]) => TArgs | null;

type ParsedRouteArgs<TParse extends RouteArgParser<unknown>> = Exclude<ReturnType<TParse>, null>;

/** Typed parsed route definition that binds one parser to its runner. */
type RoutedCommandDefinition<TParse extends RouteArgParser<unknown>> = {
  parseArgs: TParse;
  runParsedArgs: (args: ParsedRouteArgs<TParse>) => Promise<void>;
};

/** Erased routed-command definition map shape used by route-spec generation. */
export type AnyRoutedCommandDefinition = {
  parseArgs: RouteArgParser<unknown>;
  runParsedArgs: (args: never) => Promise<void>;
};

function defineRoutedCommand<TParse extends RouteArgParser<unknown>>(
  definition: RoutedCommandDefinition<TParse>,
): RoutedCommandDefinition<TParse> {
  return definition;
}

const loadConfigCli = createLazyPromise(() => import("../config-cli.js"));
const loadAgentsListCommand = createLazyPromise(
  () => import("../../commands/agents.commands.list.js"),
);
const loadModelsListCommand = createLazyPromise(
  () => import("../../commands/models/list.list-command.js"),
);
const loadModelsStatusCommand = createLazyPromise(
  () => import("../../commands/models/list.status-command.js"),
);
const loadTasksJsonCommand = createLazyPromise(() => import("../../commands/tasks-json.js"));

/** Route id to lazy parser/runner definition. */
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
            ...(args.agent !== undefined ? { agent: args.agent } : {}),
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
  "gateway-health": defineRoutedCommand({
    parseArgs: parseGatewayHealthRouteArgs,
    runParsedArgs: async (args) => {
      const { runGatewayHealthJsonRoute } = await import("../gateway-cli/health-route.js");
      await runGatewayHealthJsonRoute(args, defaultRuntime);
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
      const { agentsListCommand } = await loadAgentsListCommand();
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
  "tasks-list": defineRoutedCommand({
    parseArgs: parseTasksListRouteArgs,
    runParsedArgs: async (args) => {
      const { tasksListJsonCommand } = await loadTasksJsonCommand();
      await tasksListJsonCommand(args, defaultRuntime);
    },
  }),
  "tasks-audit": defineRoutedCommand({
    parseArgs: parseTasksAuditRouteArgs,
    runParsedArgs: async (args) => {
      const { tasksAuditJsonCommand } = await loadTasksJsonCommand();
      await tasksAuditJsonCommand(args, defaultRuntime);
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
  "plugins-list": defineRoutedCommand({
    parseArgs: parsePluginsListRouteArgs,
    runParsedArgs: async (args) => {
      const { runPluginsListCommand } = await import("../plugins-list-command.js");
      await runPluginsListCommand(args, defaultRuntime);
    },
  }),
};
