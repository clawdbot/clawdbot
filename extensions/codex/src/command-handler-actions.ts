import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import type { CodexComputerUseSetupParams } from "./app-server/computer-use.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import { canMutateCodexHost } from "./command-authorization.js";
import {
  formatCodexDisplayText,
  formatComputerUseStatus,
  readString,
} from "./command-formatters.js";
import {
  formatComputerUsePersistentIdentityMigration,
  parseBindArgs,
  parseComputerUseArgs,
  parseResumeArgs,
} from "./command-handler-args.js";
import { isCurrentSessionModelSelectionLocked } from "./command-handler-bindings.js";
import { CODEX_CONTROL_METHODS, type CodexCommandDeps } from "./command-handler-deps.js";
import {
  resolveCodexConversationControlScope,
  resolveControlTarget,
} from "./command-handler-scope.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import { parseCodexFastModeArg, parseCodexPermissionsModeArg } from "./conversation-control.js";

const CODEX_NATIVE_EXECUTION_SUBCOMMANDS = new Set([
  "bind",
  "resume",
  "steer",
  "model",
  "fast",
  "permissions",
  "compact",
  "review",
  "goal",
]);

export const CODEX_NATIVE_CONTROL_SUBCOMMANDS = new Set([
  ...CODEX_NATIVE_EXECUTION_SUBCOMMANDS,
  "detach",
  "unbind",
  "stop",
]);

export function resolveCodexNativeCommandSandboxBlock(
  ctx: PluginCommandContext,
  subcommand: string,
  args: readonly string[],
): string | undefined {
  if (isReadOnlyCodexGoalCommand(subcommand, args)) {
    return undefined;
  }
  if (!CODEX_NATIVE_EXECUTION_SUBCOMMANDS.has(subcommand)) {
    return undefined;
  }
  if (returnsBeforeNativeCodexExecution(subcommand, args)) {
    return undefined;
  }
  if (isCodexCliNodeResumeBind(subcommand, args)) {
    return resolveCodexNativeSandboxBlock({
      config: ctx.config,
      sessionKey: ctx.sessionKey,
      sessionId: ctx.sessionId,
      surface: `/${["codex", subcommand].join(" ")}`,
    });
  }
  return resolveCodexNativeExecutionBlock({
    config: ctx.config,
    agentId: ctx.agentId,
    sessionKey: ctx.sessionKey,
    sessionId: ctx.sessionId,
    surface: `/${["codex", subcommand].join(" ")}`,
  });
}

export function isReadOnlyCodexGoalCommand(subcommand: string, args: readonly string[]): boolean {
  if (subcommand !== "goal" || args.length > 1) {
    return false;
  }
  const action = (args[0] ?? "status").toLowerCase();
  return action === "status" || action === "get";
}

export function returnsBeforeNativeCodexExecution(
  subcommand: string,
  args: readonly string[],
): boolean {
  switch (subcommand) {
    case "bind":
      return parseBindArgs([...args]).help === true;
    case "resume":
      return returnsBeforeNativeCodexResume(args);
    case "steer":
      return args.join(" ").trim() === "";
    case "model":
      return args.length === 0 || args.length > 1;
    case "fast":
      return args.length === 0 || args.length > 1 || parseCodexFastModeArg(args[0]) === undefined;
    case "permissions":
      return (
        args.length === 0 || args.length > 1 || parseCodexPermissionsModeArg(args[0]) === undefined
      );
    case "compact":
    case "review":
    case "detach":
    case "unbind":
    case "stop":
      return args.length > 0;
    default:
      return false;
  }
}

function isCodexCliNodeResumeBind(subcommand: string, args: readonly string[]): boolean {
  if (subcommand !== "resume") {
    return false;
  }
  const parsed = parseResumeArgs([...args]);
  return Boolean(parsed.host && parsed.threadId && parsed.bindHere === true && !parsed.help);
}

function returnsBeforeNativeCodexResume(args: readonly string[]): boolean {
  const parsed = parseResumeArgs([...args]);
  const normalizedThreadId = parsed.threadId?.trim();
  if (parsed.help) {
    return true;
  }
  if (parsed.host) {
    return !normalizedThreadId || parsed.bindHere !== true;
  }
  return !normalizedThreadId || args.length !== 1;
}

export async function handleComputerUseCommand(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const parsed = parseComputerUseArgs(args);
  if (parsed.help) {
    return [
      "Usage: /codex computer-use [status|install] [--source <marketplace-source>] [--marketplace-path <path>] [--marketplace <name>]",
      "Checks or installs the configured Codex Computer Use plugin through app-server.",
    ].join("\n");
  }
  if (Object.keys(parsed.persistentIdentity).length > 0) {
    return formatComputerUsePersistentIdentityMigration(parsed);
  }
  if (parsed.action === "install" && !canMutateCodexHost(ctx)) {
    return "Only an owner or operator.admin gateway client can configure Codex Computer Use.";
  }
  const { agentDir } = resolveCodexConversationControlScope(ctx);
  const params: CodexComputerUseSetupParams = {
    pluginConfig,
    config: ctx.config,
    agentDir,
    forceEnable: parsed.action === "install" || parsed.hasOverrides,
    ...(Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}),
  };
  if (parsed.action === "install") {
    return formatComputerUseStatus(await deps.installCodexComputerUse(params));
  }
  return formatComputerUseStatus(await deps.readCodexComputerUseStatus(params));
}

export async function handleNativeGoal(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  const action = (args[0] ?? "status").toLowerCase();
  const objective = args.slice(1).join(" ").trim();
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot manage the Codex goal because this command has no stable binding identity.";
  }
  const binding = await deps.bindingStore.read(target.identity);
  if (!binding?.threadId) {
    return "No Codex thread is attached to this OpenClaw session yet.";
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding.authProfileId,
    pluginConfig,
  });
  const goalRequestOptions: CodexControlRequestOptions = {
    agentDir: target.agentDir,
    authProfileId: connection.clientAuthProfileId,
    config: ctx.config,
    ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
  };
  if (action === "status" || action === "get") {
    if (args.length > 1) {
      return "Usage: /codex goal [status]";
    }
    const response = await deps.codexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.getThreadGoal,
      { threadId: binding.threadId },
      goalRequestOptions,
    );
    return formatNativeGoal(response);
  }
  if (action === "clear") {
    if (args.length > 1) {
      return "Usage: /codex goal clear";
    }
    const response = await deps.codexControlRequest(
      pluginConfig,
      CODEX_CONTROL_METHODS.clearThreadGoal,
      { threadId: binding.threadId },
      goalRequestOptions,
    );
    return isJsonObject(response) && response.cleared === true
      ? "Cleared the Codex goal."
      : "No Codex goal was active.";
  }
  const requestedStatus =
    action === "pause"
      ? "paused"
      : action === "resume"
        ? "active"
        : action === "block"
          ? "blocked"
          : action === "complete"
            ? "complete"
            : undefined;
  const isObjectiveUpdate = action === "set";
  if ((!requestedStatus && !isObjectiveUpdate) || (isObjectiveUpdate && !objective)) {
    return "Usage: /codex goal [status|set <objective>|pause|resume|block|complete|clear]";
  }
  if (requestedStatus && args.length > 1) {
    return `Usage: /codex goal ${action}`;
  }
  const response = await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.setThreadGoal,
    {
      threadId: binding.threadId,
      ...(objective ? { objective } : {}),
      // Upstream thread/goal/set creates or partially updates the native goal;
      // omitted status and budget preserve Codex's canonical state.
      ...(requestedStatus ? { status: requestedStatus } : {}),
    },
    goalRequestOptions,
  );
  return formatNativeGoal(response);
}

function formatNativeGoal(response: JsonValue | undefined): string {
  const goal = isJsonObject(response) && isJsonObject(response.goal) ? response.goal : undefined;
  if (!goal) {
    return "No Codex goal is active.";
  }
  const objective = readString(goal, "objective") ?? "unknown";
  const status = readString(goal, "status") ?? "unknown";
  const tokensUsed = typeof goal.tokensUsed === "number" ? goal.tokensUsed : 0;
  const tokenBudget = typeof goal.tokenBudget === "number" ? goal.tokenBudget : undefined;
  return [
    `Codex goal: ${formatCodexDisplayText(objective)}`,
    `- Status: ${formatCodexDisplayText(status)}`,
    `- Tokens: ${tokensUsed}${tokenBudget === undefined ? "" : ` / ${tokenBudget}`}`,
  ].join("\n");
}

export async function stopConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
): Promise<string> {
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot stop Codex because this command did not include a stable binding identity.";
  }
  return (
    await deps.stopCodexConversationTurn({
      identity: target.identity,
      bindingStore: deps.bindingStore,
      pluginConfig,
      agentDir: target.agentDir,
      config: ctx.config,
    })
  ).message;
}

export async function steerConversationTurn(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  message: string,
): Promise<string> {
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot steer Codex because this command did not include a stable binding identity.";
  }
  return (
    await deps.steerCodexConversationTurn({
      identity: target.identity,
      bindingStore: deps.bindingStore,
      message,
      pluginConfig,
      agentDir: target.agentDir,
      config: ctx.config,
    })
  ).message;
}

export async function setConversationModel(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex model <model>";
  }
  const [model = ""] = args;
  const normalized = model.trim();
  if (normalized && isCurrentSessionModelSelectionLocked(ctx)) {
    return MODEL_SELECTION_LOCKED_MESSAGE;
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex model because this command did not include a stable binding identity.";
  }
  if (!normalized) {
    const binding = await deps.bindingStore.read(target.identity);
    return binding?.model
      ? `Codex model: ${formatCodexDisplayText(binding.model)}`
      : "Usage: /codex model <model>";
  }
  return await deps.setCodexConversationModel({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    pluginConfig,
    model: normalized,
    agentDir: target.agentDir,
    config: ctx.config,
  });
}

export async function setConversationFastMode(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex fast [on|off|status]";
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex fast mode because this command did not include a stable binding identity.";
  }
  const value = args[0];
  const parsed = parseCodexFastModeArg(value);
  if (value && parsed == null && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex fast [on|off|status]";
  }
  return await deps.setCodexConversationFastMode({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    enabled: parsed,
  });
}

export async function setConversationPermissions(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  args: string[],
): Promise<string> {
  if (args.length > 1) {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return "Cannot set Codex permissions because this command did not include a stable binding identity.";
  }
  const value = args[0];
  const parsed = parseCodexPermissionsModeArg(value);
  if (value && !parsed && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  return await deps.setCodexConversationPermissions({
    identity: target.identity,
    bindingStore: deps.bindingStore,
    mode: parsed,
  });
}

export async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  kind: "compact" | "review",
  args: string[],
): Promise<string> {
  const label = kind === "compact" ? "compaction" : "review";
  if (args.length > 0) {
    return `Usage: /codex ${label === "compaction" ? "compact" : label}`;
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return `Cannot start Codex ${label} because this command did not include a stable binding identity.`;
  }
  const binding = await deps.bindingStore.read(target.identity);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding.authProfileId,
    pluginConfig,
  });
  await deps.codexControlRequest(
    pluginConfig,
    kind === "compact" ? CODEX_CONTROL_METHODS.compact : CODEX_CONTROL_METHODS.review,
    kind === "review"
      ? { threadId: binding.threadId, target: { type: "uncommittedChanges" } }
      : { threadId: binding.threadId },
    {
      agentDir: target.agentDir,
      authProfileId: connection.clientAuthProfileId,
      config: ctx.config,
      ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
    },
  );
  return `Started Codex ${label} for thread ${formatCodexDisplayText(binding.threadId)}.`;
}
