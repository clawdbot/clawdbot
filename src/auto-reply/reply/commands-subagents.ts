// Dispatches subagent inspection commands.
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import {
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  type SubagentsCommandContext,
} from "./commands-subagents/shared.js";
import type { CommandHandler } from "./commands-types.js";

const actionAgentsLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-agents.js"),
);
const actionHelpLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-help.js"),
);
const actionInfoLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-info.js"),
);
const actionListLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-list.js"),
);
const actionLogLoader = createLazyImportLoader(() => import("./commands-subagents/action-log.js"));
const controlRuntimeLoader = createLazyImportLoader(
  () => import("./commands-subagents-control.runtime.js"),
);

export const handleSubagentsCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/subagents",
    match: (body) => resolveHandledPrefix(body) ?? null,
    silentUnauthorized: true,
  },
  async (params, handledPrefix) => {
    const normalized = params.command.commandBodyNormalized;
    const rest = normalized.slice(handledPrefix.length).trim();
    const restTokens = rest.split(/\s+/).filter(Boolean);
    const action = resolveSubagentsAction({ handledPrefix, restTokens });
    if (!action) {
      return (await actionHelpLoader.load()).handleSubagentsHelpAction();
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

    switch (action) {
      case "help":
        return (await actionHelpLoader.load()).handleSubagentsHelpAction();
      case "agents":
        return (await actionAgentsLoader.load()).handleSubagentsAgentsAction(ctx);
      case "list":
        return (await actionListLoader.load()).handleSubagentsListAction(ctx);
      case "info":
        return (await actionInfoLoader.load()).handleSubagentsInfoAction(ctx);
      case "log":
        return await (await actionLogLoader.load()).handleSubagentsLogAction(ctx);
      default:
        return (await actionHelpLoader.load()).handleSubagentsHelpAction();
    }
  },
);
