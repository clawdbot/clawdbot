import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  resolvePersistedSessionRuntimeId,
} from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import type { CodexComputerUseSetupParams } from "./app-server/computer-use.js";
import { isJsonObject, type JsonValue } from "./app-server/protocol.js";
import {
  resolveCodexNativeExecutionBlock,
  resolveCodexNativeSandboxBlock,
} from "./app-server/sandbox-guard.js";
import { sessionBindingIdentity } from "./app-server/session-binding.js";
import { isSameCodexAppServerThreadOwner } from "./app-server/thread-ownership.js";
import {
  canMutateCodexHost,
  CODEX_FULL_PERMISSIONS_AUTH_ERROR,
  hasCodexAdminScope,
} from "./command-authorization.js";
import { formatCodexDisplayText, formatComputerUseStatus } from "./command-formatters.js";
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
  const objective = normalizeOptionalString(goal.objective) ?? "unknown";
  const status = normalizeOptionalString(goal.status) ?? "unknown";
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
    const currentSession =
      ctx.sessionId && ctx.sessionKey
        ? getSessionEntry({
            storePath: resolveStorePath(ctx.config.session?.store, { agentId: target.agentId }),
            sessionKey: ctx.sessionKey,
            hydrateSkillPromptRefs: false,
            readConsistency: "latest",
          })
        : undefined;
    const selectedModel =
      currentSession && currentSession.sessionId === ctx.sessionId
        ? (currentSession.modelOverride ?? currentSession.model)
        : undefined;
    const binding = await deps.bindingStore.read(target.identity);
    // Direct sessions report their desired selection; bound conversations
    // must never mistake an ambient outer-session model for native ownership.
    const activeModel =
      target.identity.kind === "conversation" ? binding?.model : (selectedModel ?? binding?.model);
    return activeModel
      ? `Codex model: ${formatCodexDisplayText(activeModel)}`
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
  if (!target || !ctx.sessionId || !ctx.sessionKey) {
    return "Cannot set Codex permissions because this command did not include a complete session identity.";
  }
  const value = args[0];
  const parsed = parseCodexPermissionsModeArg(value);
  if (value && !parsed && value.trim().toLowerCase() !== "status") {
    return "Usage: /codex permissions [default|yolo|status]";
  }
  // Match sessions.create/sessions.patch: full access requires operator.admin,
  // even when the command sender is an owner.
  if (parsed === "yolo" && !hasCodexAdminScope(ctx)) {
    return CODEX_FULL_PERMISSIONS_AUTH_ERROR;
  }
  return await deps.setCodexConversationPermissions({
    mode: parsed,
    config: ctx.config,
    session: {
      agentId: target.agentId,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    },
  });
}

export async function startThreadAction(
  deps: CodexCommandDeps,
  ctx: PluginCommandContext,
  pluginConfig: unknown,
  kind: "compact" | "review",
  args: string[],
): Promise<string> {
  if (args.length > 0) {
    return `Usage: /codex ${kind}`;
  }
  const target = await resolveControlTarget(ctx);
  if (!target) {
    return `Cannot start Codex ${kind === "compact" ? "compaction" : "review"} because this command did not include a stable binding identity.`;
  }
  const binding = await deps.bindingStore.read(target.identity);
  if (!binding?.threadId) {
    return `No Codex thread is attached to this OpenClaw session yet.`;
  }
  if (kind === "compact") {
    const sessionTarget = ctx.sessionTarget;
    if (
      !ctx.sessionId ||
      !ctx.sessionKey ||
      !sessionTarget ||
      sessionTarget.sessionId !== ctx.sessionId ||
      sessionTarget.sessionKey !== ctx.sessionKey
    ) {
      return "Codex compaction is unavailable because this command is not bound to a complete session identity.";
    }
    const currentSession = getSessionEntry({
      storePath: sessionTarget.storePath,
      sessionKey: ctx.sessionKey,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
    if (
      currentSession?.sessionId !== ctx.sessionId ||
      resolvePersistedSessionRuntimeId(currentSession) !== "codex"
    ) {
      return "Codex compaction is unavailable because the current OpenClaw session is not using the Codex runtime.";
    }
    if (target.identity.kind === "conversation") {
      const sessionBinding = ctx.sessionId
        ? await deps.bindingStore.read(
            sessionBindingIdentity({
              sessionId: ctx.sessionId,
              sessionKey: ctx.sessionKey,
              agentId: sessionTarget.agentId,
              config: ctx.config,
            }),
          )
        : undefined;
      if (!isSameCodexAppServerThreadOwner(binding, sessionBinding)) {
        return "Codex compaction is unavailable because the conversation-bound thread differs from the current session binding. Resume that thread into the session first.";
      }
    }
    const compactCurrent = ctx.runtimeContext?.compactCurrent;
    if (!compactCurrent) {
      return "Codex compaction is unavailable because this command is not bound to a session.";
    }
    const result = await compactCurrent();
    return result.compacted
      ? `Compacted Codex session (${result.tokensAfter ?? "unknown"} tokens after).`
      : `Codex compaction did not complete: ${formatCodexDisplayText(result.reason ?? "no reason returned")}.`;
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding.authProfileId,
    pluginConfig,
  });
  await deps.codexControlRequest(
    pluginConfig,
    CODEX_CONTROL_METHODS.review,
    { threadId: binding.threadId, target: { type: "uncommittedChanges" } },
    {
      agentDir: target.agentDir,
      authProfileId: connection.clientAuthProfileId,
      config: ctx.config,
      ...(connection.usesSupervisionConnection ? { startOptions: connection.appServer.start } : {}),
    },
  );
  return `Started Codex review for thread ${formatCodexDisplayText(binding.threadId)}.`;
}
