// Dispatches subagent inspection commands.
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import {
  buildSubagentsHelp,
  resolveRequesterSessionKey,
  type SubagentsCommandContext,
} from "./commands-subagents/shared.js";
import type { CommandHandler } from "./commands-types.js";

const actionAgentsLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-agents.js"),
);
const actionInfoLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-info.js"),
);
const actionListLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-list.js"),
);
const actionLogLoader = createLazyImportLoader(() => import("./commands-subagents/action-log.js"));
const controlRuntimeLoader = createLazyImportLoader(
  () => import("../../agents/subagents/registry/subagent-control-scope.js"),
);

export const handleSubagentsCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/subagents",
    match: (
      body,
    ): { action: "agents" | "list" | "info" | "log" | "help"; restTokens: string[] } | null => {
      const rest = matchCommandPrefix(body, "/subagents");
      if (rest !== null) {
        const [rawAction = "list", ...restTokens] = rest.split(/\s+/).filter(Boolean);
        const action = rawAction.toLowerCase();
        return {
          action: action === "list" || action === "info" || action === "log" ? action : "help",
          restTokens,
        };
      }
      return matchCommandPrefix(body, "/agents") === null
        ? null
        : { action: "agents", restTokens: [] };
    },
    silentUnauthorized: true,
  },
  async (params, { action, restTokens }) => {
    if (action === "help") {
      return commandReply(buildSubagentsHelp());
    }

    const requesterKey = resolveRequesterSessionKey(params);
    if (!requesterKey) {
      return commandReply("⚠️ Missing session key.");
    }

    const ctx: SubagentsCommandContext = {
      params,
      requesterKey,
      runs: (await controlRuntimeLoader.load()).listControlledSubagentRuns(requesterKey),
      restTokens,
    };

    if (action === "agents") {
      return (await actionAgentsLoader.load()).handleSubagentsAgentsAction(ctx);
    }
    if (action === "list") {
      return (await actionListLoader.load()).handleSubagentsListAction(ctx);
    }
    if (action === "info") {
      return (await actionInfoLoader.load()).handleSubagentsInfoAction(ctx);
    }
    return await (await actionLogLoader.load()).handleSubagentsLogAction(ctx);
  },
);
