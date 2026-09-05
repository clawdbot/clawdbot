// Formats ACP runtime option details for command responses.
import { resolveAcpSessionIdentifierLinesFromIdentity } from "@openclaw/acp-core/runtime/session-identifiers";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import type { AcpSessionTarget } from "../../../acp/control-plane/manager.types.js";
import {
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeCwdInput,
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
} from "../../../acp/control-plane/runtime-options.js";
import type { AcpSessionRuntimeOptions } from "../../../config/sessions/types.js";
import { findLatestTaskForRelatedSessionKeyForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
import { commandReply } from "../command-gates.js";
import type { CommandHandlerResult, HandleCommandsParams } from "../commands-types.js";
import {
  ACP_CWD_USAGE,
  ACP_MODEL_USAGE,
  ACP_PERMISSIONS_USAGE,
  ACP_RESET_OPTIONS_USAGE,
  ACP_SET_MODE_USAGE,
  ACP_STATUS_USAGE,
  ACP_TIMEOUT_USAGE,
  formatAcpCapabilitiesText,
  formatRuntimeOptionsText,
  parseOptionalSingleTarget,
  parseSetCommandInput,
  parseSingleValueCommandInput,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

async function resolveTargetSessionKeyOrStop(params: {
  commandParams: HandleCommandsParams;
  token: string | undefined;
}): Promise<AcpSessionTarget | CommandHandlerResult> {
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token: params.token,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }
  return target;
}

async function resolveOptionalSingleTargetOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<AcpSessionTarget | CommandHandlerResult> {
  const parsed = parseOptionalSingleTarget(params.restTokens, params.usage);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  return await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.sessionToken,
  });
}

type SingleTargetValue = {
  target: AcpSessionTarget;
  value: string;
};

async function resolveSingleTargetValueOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<SingleTargetValue | CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(params.restTokens, params.usage);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  const target = await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.value.sessionToken,
  });
  if (!("sessionKey" in target)) {
    return target;
  }
  return {
    target,
    value: parsed.value.value,
  };
}

async function withSingleTargetValue<T>(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
  run: (resolved: SingleTargetValue) => Promise<T | CommandHandlerResult>;
}): Promise<T | CommandHandlerResult> {
  const resolved = await resolveSingleTargetValueOrStop({
    commandParams: params.commandParams,
    restTokens: params.restTokens,
    usage: params.usage,
  });
  if (!("target" in resolved)) {
    return resolved;
  }
  return await params.run(resolved);
}

async function handleSingleRuntimeOptionAction<T>(
  commandParams: HandleCommandsParams,
  restTokens: string[],
  action: {
    usage: string;
    optionLabel: string;
    parseValue: (value: string) => T;
    formatValue?: (value: T) => string;
    update: (target: AcpSessionTarget, value: T) => Promise<AcpSessionRuntimeOptions>;
  },
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams,
    restTokens,
    usage: action.usage,
    run: async ({ target, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const parsedValue = action.parseValue(value);
          const options = await action.update(target, parsedValue);
          return { parsedValue, options };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: `Could not update ACP ${action.optionLabel}.`,
        onSuccess: ({ parsedValue, options }) => {
          const valueText = action.formatValue?.(parsedValue) ?? String(parsedValue);
          return commandReply(
            `✅ Updated ACP ${action.optionLabel} for ${target.sessionKey}: ${valueText}. Effective options: ${formatRuntimeOptionsText(options)}`,
          );
        },
      }),
  });
}

export async function handleAcpStatusAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const target = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_STATUS_USAGE,
  });
  if (!("sessionKey" in target)) {
    return target;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().getSessionStatus({
        cfg: params.cfg,
        ...target,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not read ACP session status.",
    onSuccess: (status) => {
      const linkedTask = findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: status.sessionKey,
        callerOwnerKey: params.sessionKey,
        callerAgentId: params.agentId,
        config: params.cfg,
      });
      const sessionIdentifierLines = resolveAcpSessionIdentifierLinesFromIdentity({
        backend: status.backend,
        identity: status.identity,
      });
      const taskProgress = sanitizeTaskStatusText(linkedTask?.progressSummary);
      const taskSummary = sanitizeTaskStatusText(linkedTask?.terminalSummary, {
        errorContext: true,
      });
      const taskError = sanitizeTaskStatusText(linkedTask?.error, { errorContext: true });
      const lastError = sanitizeTaskStatusText(status.lastError, { errorContext: true });
      const runtimeSummary = sanitizeTaskStatusText(status.runtimeStatus?.summary, {
        errorContext: true,
      });
      const runtimeDetails = sanitizeTaskStatusText(status.runtimeStatus?.details, {
        errorContext: true,
      });
      const taskUpdatedAt =
        typeof linkedTask?.lastEventAt === "number"
          ? timestampMsToIsoString(linkedTask.lastEventAt)
          : undefined;
      const lastActivityAt = timestampMsToIsoString(status.lastActivityAt) ?? "n/a";
      const lines = [
        "ACP status:",
        "-----",
        `session: ${status.sessionKey}`,
        `owner: ${target.agentId}`,
        `backend: ${status.backend}`,
        `agent: ${status.agent}`,
        ...sessionIdentifierLines,
        `sessionMode: ${status.mode}`,
        `state: ${status.state}`,
        ...(linkedTask
          ? [
              `taskId: ${linkedTask.taskId}`,
              `taskStatus: ${linkedTask.status}`,
              `delivery: ${linkedTask.deliveryStatus}`,
              ...(taskProgress ? [`taskProgress: ${taskProgress}`] : []),
              ...(taskSummary ? [`taskSummary: ${taskSummary}`] : []),
              ...(taskError ? [`taskError: ${taskError}`] : []),
              ...(taskUpdatedAt ? [`taskUpdatedAt: ${taskUpdatedAt}`] : []),
            ]
          : []),
        `runtimeOptions: ${formatRuntimeOptionsText(status.runtimeOptions)}`,
        `capabilities: ${formatAcpCapabilitiesText(status.capabilities.controls)}`,
        `lastActivityAt: ${lastActivityAt}`,
        ...(lastError ? [`lastError: ${lastError}`] : []),
        ...(runtimeSummary ? [`runtime: ${runtimeSummary}`] : []),
        ...(runtimeDetails ? [`runtimeDetails: ${runtimeDetails}`] : []),
      ];
      return commandReply(lines.join("\n"));
    },
  });
}

export async function handleAcpSetModeAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_SET_MODE_USAGE,
    run: async ({ target, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const runtimeMode = validateRuntimeModeInput(value);
          const options = await getAcpSessionManager().setSessionRuntimeMode({
            cfg: params.cfg,
            ...target,
            runtimeMode,
          });
          return {
            runtimeMode,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP runtime mode.",
        onSuccess: ({ runtimeMode, options }) =>
          commandReply(
            `✅ Updated ACP runtime mode for ${target.sessionKey}: ${runtimeMode}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpSetAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const parsed = parseSetCommandInput(restTokens);
  if (!parsed.ok) {
    return commandReply(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return commandReply(`⚠️ ${target.error}`);
  }
  const key = parsed.value.key.trim();
  const value = parsed.value.value.trim();

  return await withAcpCommandErrorBoundary({
    run: async () => {
      const lowerKey = normalizeLowercaseStringOrEmpty(key);
      if (lowerKey === "cwd") {
        const cwd = validateRuntimeCwdInput(value);
        const options = await getAcpSessionManager().updateSessionRuntimeOptions({
          cfg: params.cfg,
          ...target,
          patch: { cwd },
        });
        return {
          text: `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
        };
      }
      const validated = validateRuntimeConfigOptionInput(key, value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        ...target,
        key: validated.key,
        value: validated.value,
      });
      return {
        text: `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}`,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP config option.",
    onSuccess: ({ text }) => commandReply(text),
  });
}

export async function handleAcpCwdAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await handleSingleRuntimeOptionAction(params, restTokens, {
    usage: ACP_CWD_USAGE,
    optionLabel: "cwd",
    parseValue: validateRuntimeCwdInput,
    update: async (target, value) =>
      await getAcpSessionManager().updateSessionRuntimeOptions({
        cfg: params.cfg,
        ...target,
        patch: { cwd: value },
      }),
  });
}

export async function handleAcpPermissionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await handleSingleRuntimeOptionAction(params, restTokens, {
    usage: ACP_PERMISSIONS_USAGE,
    optionLabel: "permissions profile",
    parseValue: validateRuntimePermissionProfileInput,
    update: async (target, value) =>
      await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        ...target,
        key: "approval_policy",
        value,
      }),
  });
}

export async function handleAcpTimeoutAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await handleSingleRuntimeOptionAction(params, restTokens, {
    usage: ACP_TIMEOUT_USAGE,
    optionLabel: "timeout",
    parseValue: parseRuntimeTimeoutSecondsInput,
    formatValue: (value) => `${value}s`,
    update: async (target, value) =>
      await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        ...target,
        key: "timeout",
        value: String(value),
      }),
  });
}

export async function handleAcpModelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await handleSingleRuntimeOptionAction(params, restTokens, {
    usage: ACP_MODEL_USAGE,
    optionLabel: "model",
    parseValue: validateRuntimeModelInput,
    update: async (target, value) =>
      await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        ...target,
        key: "model",
        value,
      }),
  });
}

export async function handleAcpResetOptionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const target = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_RESET_OPTIONS_USAGE,
  });
  if (!("sessionKey" in target)) {
    return target;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().resetSessionRuntimeOptions({
        cfg: params.cfg,
        ...target,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not reset ACP runtime options.",
    onSuccess: () => commandReply(`✅ Reset ACP runtime options for ${target.sessionKey}.`),
  });
}
