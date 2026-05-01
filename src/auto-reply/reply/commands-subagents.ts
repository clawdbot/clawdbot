import { logVerbose } from "../../globals.js";
import {
  resolveHandledPrefix,
  resolveRequesterSessionKey,
  resolveSubagentsAction,
  stopWithText,
  type SubagentsCommandContext,
} from "./commands-subagents-dispatch.js";
import type { CommandHandler } from "./commands-types.js";

let actionAgentsPromise: Promise<typeof import("./commands-subagents/action-agents.js")> | null =
  null;
let actionFocusPromise: Promise<typeof import("./commands-subagents/action-focus.js")> | null =
  null;
let actionHelpPromise: Promise<typeof import("./commands-subagents/action-help.js")> | null = null;
let actionInfoPromise: Promise<typeof import("./commands-subagents/action-info.js")> | null = null;
let actionKillPromise: Promise<typeof import("./commands-subagents/action-kill.js")> | null = null;
let actionListPromise: Promise<typeof import("./commands-subagents/action-list.js")> | null = null;
let actionLogPromise: Promise<typeof import("./commands-subagents/action-log.js")> | null = null;
let actionSendPromise: Promise<typeof import("./commands-subagents/action-send.js")> | null = null;
let actionSpawnPromise: Promise<typeof import("./commands-subagents/action-spawn.js")> | null =
  null;
let actionUnfocusPromise: Promise<typeof import("./commands-subagents/action-unfocus.js")> | null =
  null;
let controlRuntimePromise: Promise<
  typeof import("./commands-subagents-control.runtime.js")
> | null = null;

function loadAgentsAction() {
  actionAgentsPromise ??= import("./commands-subagents/action-agents.js");
  return actionAgentsPromise;
}

function loadFocusAction() {
  actionFocusPromise ??= import("./commands-subagents/action-focus.js");
  return actionFocusPromise;
}

function loadHelpAction() {
  actionHelpPromise ??= import("./commands-subagents/action-help.js");
  return actionHelpPromise;
}

function loadInfoAction() {
  actionInfoPromise ??= import("./commands-subagents/action-info.js");
  return actionInfoPromise;
}

function loadKillAction() {
  actionKillPromise ??= import("./commands-subagents/action-kill.js");
  return actionKillPromise;
}

function loadListAction() {
  actionListPromise ??= import("./commands-subagents/action-list.js");
  return actionListPromise;
}

function loadLogAction() {
  actionLogPromise ??= import("./commands-subagents/action-log.js");
  return actionLogPromise;
}

function loadSendAction() {
  actionSendPromise ??= import("./commands-subagents/action-send.js");
  return actionSendPromise;
}

function loadSpawnAction() {
  actionSpawnPromise ??= import("./commands-subagents/action-spawn.js");
  return actionSpawnPromise;
}

function loadUnfocusAction() {
  actionUnfocusPromise ??= import("./commands-subagents/action-unfocus.js");
  return actionUnfocusPromise;
}

function loadControlRuntime() {
  controlRuntimePromise ??= import("./commands-subagents-control.runtime.js");
  return controlRuntimePromise;
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

  const requesterKey =
    action === "spawn"
      ? resolveRequesterSessionKey(params, {
          preferCommandTarget: true,
        })
      : resolveRequesterSessionKey(params);
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
    case "kill":
      return await (await loadKillAction()).handleSubagentsKillAction(ctx);
    case "info":
      return (await loadInfoAction()).handleSubagentsInfoAction(ctx);
    case "log":
      return await (await loadLogAction()).handleSubagentsLogAction(ctx);
    case "send":
      return await (await loadSendAction()).handleSubagentsSendAction(ctx, false);
    case "steer":
      return await (await loadSendAction()).handleSubagentsSendAction(ctx, true);
    case "spawn":
      return await (await loadSpawnAction()).handleSubagentsSpawnAction(ctx);
    default:
      return (await loadHelpAction()).handleSubagentsHelpAction();
  }
};
