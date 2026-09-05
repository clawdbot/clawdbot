// Dispatches subagent inspection commands.
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import { buildSubagentsHelp, resolveRequesterSessionKey } from "./commands-subagents/shared.js";
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

    const actionHandler =
      action === "agents"
        ? (await actionAgentsLoader.load()).handleSubagentsAgentsAction
        : action === "list"
          ? (await actionListLoader.load()).handleSubagentsListAction
          : action === "info"
            ? (await actionInfoLoader.load()).handleSubagentsInfoAction
            : (await actionLogLoader.load()).handleSubagentsLogAction;
    const { listControlledSubagentRuns } = await controlRuntimeLoader.load();

    return await actionHandler({
      params,
      requesterKey,
      runs: listControlledSubagentRuns(requesterKey, params.agentId, params.cfg),
      restTokens,
    });
  },
);
