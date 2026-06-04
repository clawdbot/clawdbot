// Formats ACP runtime option details for command responses.
import { resolveAcpSessionIdentifierLinesFromIdentity } from "@openclaw/acp-core/runtime/session-identifiers";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../../../acp/control-plane/manager.js";
import {
  parseRuntimeTimeoutSecondsInput,
  validateRuntimeConfigOptionInput,
  validateRuntimeCwdInput,
  validateRuntimeModeInput,
  validateRuntimeModelInput,
  validateRuntimePermissionProfileInput,
} from "../../../acp/control-plane/runtime-options.js";
import { findLatestTaskForRelatedSessionKeyForOwner } from "../../../tasks/task-owner-access.js";
import { sanitizeTaskStatusText } from "../../../tasks/task-status.js";
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
  stopWithText,
  withAcpCommandErrorBoundary,
} from "./shared.js";
import { resolveAcpTargetSessionKey } from "./targets.js";

async function resolveTargetSessionKeyOrStop(params: {
  commandParams: HandleCommandsParams;
  token: string | undefined;
}): Promise<string | CommandHandlerResult> {
  const target = await resolveAcpTargetSessionKey({
    commandParams: params.commandParams,
    token: params.token,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
  }
  return target.sessionKey;
}

async function resolveOptionalSingleTargetOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<string | CommandHandlerResult> {
  const parsed = parseOptionalSingleTarget(params.restTokens, params.usage);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  return await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.sessionToken,
  });
}

type SingleTargetValue = {
  targetSessionKey: string;
  value: string;
};

async function resolveSingleTargetValueOrStop(params: {
  commandParams: HandleCommandsParams;
  restTokens: string[];
  usage: string;
}): Promise<SingleTargetValue | CommandHandlerResult> {
  const parsed = parseSingleValueCommandInput(params.restTokens, params.usage);
  if (!parsed.ok) {
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const targetSessionKey = await resolveTargetSessionKeyOrStop({
    commandParams: params.commandParams,
    token: parsed.value.sessionToken,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }
  return {
    targetSessionKey,
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
  if (!("targetSessionKey" in resolved)) {
    return resolved;
  }
  return await params.run(resolved);
}

export async function handleAcpStatusAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const targetSessionKey = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_STATUS_USAGE,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().getSessionStatus({
        cfg: params.cfg,
        sessionKey: targetSessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not read ACP session status.",
    onSuccess: (status) => {
      const linkedTask = findLatestTaskForRelatedSessionKeyForOwner({
        relatedSessionKey: status.sessionKey,
        callerOwnerKey: params.sessionKey,
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
      return stopWithText(lines.join("\n"));
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
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const runtimeMode = validateRuntimeModeInput(value);
          const options = await getAcpSessionManager().setSessionRuntimeMode({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
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
          stopWithText(
            `✅ Updated ACP runtime mode for ${targetSessionKey}: ${runtimeMode}. Effective options: ${formatRuntimeOptionsText(options)}`,
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
    return stopWithText(`⚠️ ${parsed.error}`);
  }
  const target = await resolveAcpTargetSessionKey({
    commandParams: params,
    token: parsed.value.sessionToken,
  });
  if (!target.ok) {
    return stopWithText(`⚠️ ${target.error}`);
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
          sessionKey: target.sessionKey,
          patch: { cwd },
        });
        return {
          text: `✅ Updated ACP cwd for ${target.sessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
        };
      }
      const validated = validateRuntimeConfigOptionInput(key, value);
      const options = await getAcpSessionManager().setSessionConfigOption({
        cfg: params.cfg,
        sessionKey: target.sessionKey,
        key: validated.key,
        value: validated.value,
      });
      return {
        text: `✅ Updated ACP config option for ${target.sessionKey}: ${validated.key}=${validated.value}. Effective options: ${formatRuntimeOptionsText(options)}`,
      };
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP config option.",
    onSuccess: ({ text }) => stopWithText(text),
  });
}

export async function handleAcpCwdAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_CWD_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const cwd = validateRuntimeCwdInput(value);
          const options = await getAcpSessionManager().updateSessionRuntimeOptions({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            patch: { cwd },
          });
          return {
            cwd,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP cwd.",
        onSuccess: ({ cwd, options }) =>
          stopWithText(
            `✅ Updated ACP cwd for ${targetSessionKey}: ${cwd}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpPermissionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_PERMISSIONS_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const permissionProfile = validateRuntimePermissionProfileInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "approval_policy",
            value: permissionProfile,
          });
          return {
            permissionProfile,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP permissions profile.",
        onSuccess: ({ permissionProfile, options }) =>
          stopWithText(
            `✅ Updated ACP permissions profile for ${targetSessionKey}: ${permissionProfile}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpTimeoutAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_TIMEOUT_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const timeoutSeconds = parseRuntimeTimeoutSecondsInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "timeout",
            value: String(timeoutSeconds),
          });
          return {
            timeoutSeconds,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP timeout.",
        onSuccess: ({ timeoutSeconds, options }) =>
          stopWithText(
            `✅ Updated ACP timeout for ${targetSessionKey}: ${timeoutSeconds}s. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpModelAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  return await withSingleTargetValue({
    commandParams: params,
    restTokens,
    usage: ACP_MODEL_USAGE,
    run: async ({ targetSessionKey, value }) =>
      await withAcpCommandErrorBoundary({
        run: async () => {
          const model = validateRuntimeModelInput(value);
          const options = await getAcpSessionManager().setSessionConfigOption({
            cfg: params.cfg,
            sessionKey: targetSessionKey,
            key: "model",
            value: model,
          });
          return {
            model,
            options,
          };
        },
        fallbackCode: "ACP_TURN_FAILED",
        fallbackMessage: "Could not update ACP model.",
        onSuccess: ({ model, options }) =>
          stopWithText(
            `✅ Updated ACP model for ${targetSessionKey}: ${model}. Effective options: ${formatRuntimeOptionsText(options)}`,
          ),
      }),
  });
}

export async function handleAcpResetOptionsAction(
  params: HandleCommandsParams,
  restTokens: string[],
): Promise<CommandHandlerResult> {
  const targetSessionKey = await resolveOptionalSingleTargetOrStop({
    commandParams: params,
    restTokens,
    usage: ACP_RESET_OPTIONS_USAGE,
  });
  if (typeof targetSessionKey !== "string") {
    return targetSessionKey;
  }

  return await withAcpCommandErrorBoundary({
    run: async () =>
      await getAcpSessionManager().resetSessionRuntimeOptions({
        cfg: params.cfg,
        sessionKey: targetSessionKey,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not reset ACP runtime options.",
    onSuccess: () => stopWithText(`✅ Reset ACP runtime options for ${targetSessionKey}.`),
  });
}
