import { logVerbose } from "../../globals.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
  type SubagentsCommandContext,
} from "./commands-subagents-dispatch.js";
import type { CommandHandler } from "./commands-types.js";

const actionAgentsLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-agents.js"),
);
const actionFocusLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-focus.js"),
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
const actionUnfocusLoader = createLazyImportLoader(
  () => import("./commands-subagents/action-unfocus.js"),
);
const controlRuntimeLoader = createLazyImportLoader(
  () => import("./commands-subagents-control.runtime.js"),
);

function loadAgentsAction() {
  return actionAgentsLoader.load();
}

function loadFocusAction() {
  return actionFocusLoader.load();
}

function loadHelpAction() {
  return actionHelpLoader.load();
}

function loadInfoAction() {
  return actionInfoLoader.load();
}

function loadListAction() {
  return actionListLoader.load();
}

function loadLogAction() {
  return actionLogLoader.load();
}

function loadUnfocusAction() {
  return actionUnfocusLoader.load();
}

function loadControlRuntime() {
  return controlRuntimeLoader.load();
}

export const handleSubagentsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const normalized = params.command.commandBodyNormalized;
  const handledPrefix = resolveHandledPrefix(normalized);
  if (!handledPrefix) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${handledPrefix} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(handledPrefix.length).trim();
  const restTokens = rest.split(/\s+/).filter(Boolean);
  const action = resolveSubagentsAction({ handledPrefix, restTokens });
  if (!action) {
    return (await loadHelpAction()).handleSubagentsHelpAction();
  }

  const requesterKey = resolveRequesterSessionKey(params);
  if (!requesterKey) {
    return stopWithText("⚠️ Missing session key.");
  }

  const ctx: SubagentsCommandContext = {
    params,
    handledPrefix,
    requesterKey,
    runs: (await loadControlRuntime()).listControlledSubagentRuns(requesterKey),
    restTokens,
  };

  switch (action) {
    case "help":
      return (await loadHelpAction()).handleSubagentsHelpAction();
    case "agents":
      return (await loadAgentsAction()).handleSubagentsAgentsAction(ctx);
    case "focus":
      return await (await loadFocusAction()).handleSubagentsFocusAction(ctx);
    case "unfocus":
      return await (await loadUnfocusAction()).handleSubagentsUnfocusAction(ctx);
    case "list":
      return (await loadListAction()).handleSubagentsListAction(ctx);
    case "info":
      return (await loadInfoAction()).handleSubagentsInfoAction(ctx);
    case "log":
      return await (await loadLogAction()).handleSubagentsLogAction(ctx);
    default:
      return (await loadHelpAction()).handleSubagentsHelpAction();
  }
};
