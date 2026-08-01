/** Applies directive-only command state changes without running the agent. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { renderExecTargetLabel } from "../../agents/bash-tools.exec-runtime.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeValue,
  resolveFastModeState,
} from "../../agents/fast-mode.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import {
  applyModelOverrideToSessionEntry,
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  applyModelRuntimeDirective,
  resolveModelRuntimeDirective,
} from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import { maybeHandleUnexpectedNativeDirectiveArguments } from "./directive-handling.native.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  applySessionDirectiveFields,
  canPersistSessionDirectiveDefaults,
  formatDirectiveAck,
  formatElevatedRuntimeHint,
  formatElevatedUnavailableText,
  formatInternalExecPersistenceDeniedText,
  formatInternalVerboseCurrentReplyOnlyText,
  formatInternalVerbosePersistenceDeniedText,
  enqueueModeSwitchEvents,
  persistSessionDirectiveSnapshot,
  resolveDirectiveTouchedSessionFields,
  withOptions,
} from "./directive-handling.shared.js";
import type { ReasoningLevel, ThinkLevel } from "./directives.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const DIRECTIVE_ACK_MESSAGES = {
  verbose: {
    off: "Verbose logging disabled.",
    on: "Verbose logging enabled.",
    full: "Verbose logging set to full.",
  },
  trace: {
    off: "Trace disabled.",
    on: "Trace enabled. Warning: trace output may contain sensitive information.",
    raw: "Trace set to raw. Warning: trace output may contain sensitive information.",
  },
  reasoning: {
    off: "Reasoning visibility disabled.",
    on: "Reasoning visibility enabled.",
    stream: "Reasoning stream enabled.",
  },
  elevated: {
    off: "Elevated mode disabled.",
    on: "Elevated mode set to ask (approvals may still apply).",
    ask: "Elevated mode set to ask (approvals may still apply).",
    full: "Elevated mode set to full (auto-approve).",
  },
} as const;

/** Handles inline directives that can be acknowledged without a model turn. */
export async function handleDirectiveOnly(
  params: HandleDirectiveOnlyParams,
): Promise<ReplyPayload | undefined> {
  const {
    directives,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    elevatedEnabled,
    elevatedAllowed,
    defaultProvider,
    defaultModel,
    aliasIndex,
    policyAliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  if (directives.hasTraceDirective && !params.senderIsOwner && !delegatedTraceAllowed) {
    return {
      text: "❌ /trace is restricted to owners and gateway clients with operator.admin scope.",
    };
  }
  const activeAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimePolicySessionKey = resolveRuntimePolicySessionKey({
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const runtimeIsSandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: runtimePolicySessionKey,
  }).sandboxed;
  const shouldHintDirectRuntime = directives.hasElevatedDirective && !runtimeIsSandboxed;
  const allowPrivilegedPersistence = canPersistSessionDirectiveDefaults({
    messageProvider: params.messageProvider,
    surface: params.surface,
    gatewayClientScopes: params.gatewayClientScopes,
    commandAuthorized: params.commandAuthorized,
    senderIsOwner: params.senderIsOwner,
  });
  const thinkingCatalog =
    params.thinkingCatalog && params.thinkingCatalog.length > 0
      ? params.thinkingCatalog
      : allowedModelCatalog.length > 0
        ? allowedModelCatalog
        : undefined;
  const modelInfo = await maybeHandleModelDirectiveInfo({
    directives,
    cfg: params.cfg,
    agentDir,
    activeAgentId,
    provider,
    model,
    defaultProvider,
    defaultModel,
    aliasIndex,
    policyAliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    currentThinkLevel: currentThinkLevel ?? "off",
    thinkingCatalog,
    runtimePolicySessionKey,
    resetModelOverride,
    workspaceDir: params.workspaceDir,
    surface: params.surface,
    sessionEntry,
  });
  if (modelInfo) {
    return modelInfo;
  }

  const modelResolution = resolveModelSelectionFromDirective({
    directives,
    cfg: params.cfg,
    agentDir,
    defaultProvider,
    defaultModel,
    aliasIndex,
    allowedModelKeys,
    allowedModelCatalog,
    provider,
    agentId: activeAgentId,
  });
  if (modelResolution.errorText) {
    return { text: modelResolution.errorText };
  }
  const modelSelection = modelResolution.modelSelection;
  const profileOverride = modelResolution.profileOverride;
  if (modelSelection && isModelSelectionLocked(sessionEntry)) {
    return { text: MODEL_SELECTION_LOCKED_MESSAGE };
  }

  const resolvedProvider = modelSelection?.provider ?? provider;
  const resolvedModel = modelSelection?.model ?? model;
  const modelRuntimeResolution = modelSelection
    ? resolveModelRuntimeDirective({
        rawRuntime: directives.rawModelRuntime,
        provider: resolvedProvider,
        cfg: params.cfg,
        sessionEntry,
      })
    : ({ kind: "unchanged" } as const);
  if (modelRuntimeResolution.kind === "invalid") {
    return { text: modelRuntimeResolution.errorText };
  }
  const prospectiveSessionEntry = { ...sessionEntry };
  applyModelRuntimeDirective(prospectiveSessionEntry, modelRuntimeResolution);
  const thinkingRuntime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: resolvedProvider,
    modelId: resolvedModel,
    agentId: activeAgentId,
    sessionKey: runtimePolicySessionKey,
    sessionEntry: prospectiveSessionEntry,
  });
  const fastModeState = resolveFastModeState({
    cfg: params.cfg,
    provider: resolvedProvider,
    model: resolvedModel,
    agentId: activeAgentId,
    sessionEntry: directives.clearFastMode ? undefined : sessionEntry,
  });
  const effectiveFastMode =
    directives.fastMode ??
    (directives.clearFastMode ? fastModeState.mode : currentFastMode) ??
    fastModeState.mode;
  const effectiveFastModeSource =
    directives.fastMode !== undefined ? "session" : fastModeState.source;

  if (directives.hasThinkDirective && !directives.thinkLevel && !directives.clearThinkLevel) {
    // If no argument was provided, show the current level
    if (!directives.rawThinkLevel) {
      const level = resolveSupportedThinkingLevel({
        provider: resolvedProvider,
        model: resolvedModel,
        level: currentThinkLevel ?? "off",
        catalog: thinkingCatalog,
        agentRuntime: thinkingRuntime,
      });
      return {
        text: withOptions(
          `Current thinking level: ${level}.`,
          `default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}`,
        ),
      };
    }
    return {
      text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
    };
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    return {
      text: directives.rawVerboseLevel
        ? `Unrecognized verbose level "${directives.rawVerboseLevel}". Valid levels: off, on, full.`
        : withOptions(`Current verbose level: ${currentVerboseLevel ?? "off"}.`, "on, full, off"),
    };
  }
  if (directives.hasTraceDirective && !directives.traceLevel) {
    return {
      text: directives.rawTraceLevel
        ? `Unrecognized trace level "${directives.rawTraceLevel}". Valid levels: off, on, raw.`
        : withOptions(`Current trace level: ${sessionEntry.traceLevel ?? "off"}.`, "on, off, raw"),
    };
  }
  if (
    directives.hasFastDirective &&
    directives.fastMode === undefined &&
    !directives.clearFastMode
  ) {
    const isFastStatus = normalizeLowercaseStringOrEmpty(directives.rawFastMode) === "status";
    if (!directives.rawFastMode || isFastStatus) {
      const statusText = formatFastModeCurrentStatus({
        mode: effectiveFastMode,
        source: effectiveFastModeSource,
        fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
      });
      return {
        text: isFastStatus
          ? statusText
          : withOptions(
              statusText,
              formatFastModeCommandOptions({
                fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
              }),
            ),
      };
    }
    return {
      text: `Unrecognized fast mode "${directives.rawFastMode}". Valid levels: on, off, auto, default, status.`,
    };
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    return {
      text: directives.rawReasoningLevel
        ? `Unrecognized reasoning level "${directives.rawReasoningLevel}". Valid levels: on, off, stream.`
        : withOptions(
            `Current reasoning level: ${currentReasoningLevel ?? "off"}.`,
            "on, off, stream",
          ),
    };
  }
  if (directives.hasElevatedDirective && !directives.elevatedLevel) {
    if (!directives.rawElevatedLevel) {
      if (!elevatedEnabled || !elevatedAllowed) {
        return {
          text: formatElevatedUnavailableText({
            runtimeSandboxed: runtimeIsSandboxed,
            failures: params.elevatedFailures,
            sessionKey: params.sessionKey,
          }),
        };
      }
      const level = currentElevatedLevel ?? "off";
      return {
        text: [
          withOptions(`Current elevated level: ${level}.`, "on, off, ask, full"),
          shouldHintDirectRuntime ? formatElevatedRuntimeHint() : null,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    return {
      text: `Unrecognized elevated level "${directives.rawElevatedLevel}". Valid levels: off, on, ask, full.`,
    };
  }
  if (directives.hasElevatedDirective && (!elevatedEnabled || !elevatedAllowed)) {
    return {
      text: formatElevatedUnavailableText({
        runtimeSandboxed: runtimeIsSandboxed,
        failures: params.elevatedFailures,
        sessionKey: params.sessionKey,
      }),
    };
  }
  if (directives.hasExecDirective) {
    const invalidExecMessage = directives.invalidExecHost
      ? `Unrecognized exec host "${directives.rawExecHost ?? ""}". Valid hosts: auto, sandbox, gateway, node.`
      : directives.invalidExecSecurity
        ? `Unrecognized exec security "${directives.rawExecSecurity ?? ""}". Valid: deny, allowlist, full.`
        : directives.invalidExecAsk
          ? `Unrecognized exec ask "${directives.rawExecAsk ?? ""}". Valid: off, on-miss, always.`
          : directives.invalidExecNode
            ? "Exec node requires a value."
            : undefined;
    if (invalidExecMessage) {
      return { text: invalidExecMessage };
    }
    const unexpectedExecArguments = maybeHandleUnexpectedNativeDirectiveArguments(directives);
    if (unexpectedExecArguments) {
      return unexpectedExecArguments;
    }
    if (!directives.hasExecOptions) {
      const execDefaults = resolveExecDefaults({
        cfg: params.cfg,
        sessionEntry,
        agentId: activeAgentId,
        sandboxAvailable: runtimeIsSandboxed,
      });
      const nodeLabel = execDefaults.node ? `node=${execDefaults.node}` : "node=(unset)";
      return {
        text: withOptions(
          `Current exec defaults: host=${renderExecTargetLabel(execDefaults.host)}, effective=${execDefaults.effectiveHost}, security=${execDefaults.security}, ask=${execDefaults.ask}, ${nodeLabel}.`,
          "host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>",
        ),
      };
    }
  }

  const queueAck = maybeHandleQueueDirective({
    directives,
    cfg: params.cfg,
    channel: provider,
    sessionEntry,
  });
  if (queueAck) {
    return queueAck;
  }

  const unexpectedNativeArguments = maybeHandleUnexpectedNativeDirectiveArguments(directives);
  if (unexpectedNativeArguments) {
    return unexpectedNativeArguments;
  }

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel &&
    !isThinkingLevelSupported({
      provider: resolvedProvider,
      model: resolvedModel,
      level: directives.thinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    })
  ) {
    return {
      text: `Thinking level "${directives.thinkLevel}" is not supported for ${resolvedProvider}/${resolvedModel}. Use one of: ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
    };
  }

  const resolvedDirectiveThinkLevel = directives.thinkLevel;
  const nextThinkLevel = directives.hasThinkDirective
    ? resolvedDirectiveThinkLevel
    : ((sessionEntry?.thinkingLevel as ThinkLevel | undefined) ?? currentThinkLevel);
  const remappedUnsupportedThinkLevel =
    !directives.hasThinkDirective &&
    nextThinkLevel &&
    !isThinkingLevelSupported({
      provider: resolvedProvider,
      model: resolvedModel,
      level: nextThinkLevel,
      catalog: thinkingCatalog,
      agentRuntime: thinkingRuntime,
    })
      ? resolveSupportedThinkingLevel({
          provider: resolvedProvider,
          model: resolvedModel,
          level: nextThinkLevel,
          catalog: thinkingCatalog,
          agentRuntime: thinkingRuntime,
        })
      : undefined;
  const shouldRemapUnsupportedThinkLevel =
    Boolean(remappedUnsupportedThinkLevel) && remappedUnsupportedThinkLevel !== nextThinkLevel;

  const prevReasoningLevel =
    currentReasoningLevel ?? (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  const elevatedChanged =
    directives.hasElevatedDirective &&
    directives.elevatedLevel !== undefined &&
    elevatedEnabled &&
    elevatedAllowed;
  let modelSelectionUpdated = false;
  let modelSelectionApplied = true;
  let sessionChangesApplied = true;
  const appliedSessionEntry = sessionEntry;
  const touchedSessionFields = resolveDirectiveTouchedSessionFields({
    directives,
    allowPrivilegedPersistence,
  });
  if (shouldRemapUnsupportedThinkLevel && !touchedSessionFields.includes("thinkingLevel")) {
    touchedSessionFields.push("thinkingLevel");
  }
  // Validated, authorized directives have already named every field they can mutate.
  const shouldPersistSessionEntry = touchedSessionFields.length > 0;
  const fastModeChanged =
    (directives.hasFastDirective &&
      directives.fastMode !== undefined &&
      directives.fastMode !== currentFastMode) ||
    (directives.clearFastMode && currentFastMode !== fastModeState.mode);
  const reasoningChanged =
    directives.hasReasoningDirective &&
    directives.reasoningLevel !== undefined &&
    directives.reasoningLevel !== prevReasoningLevel;
  if (shouldPersistSessionEntry) {
    const initialSessionEntry = { ...sessionEntry };
    applySessionDirectiveFields({
      directives,
      sessionEntry,
      allowPrivilegedPersistence,
      allowTracePersistence: true,
      allowElevatedPersistence: elevatedEnabled && elevatedAllowed,
      persistDirectiveOnlyFields: true,
    });
    if (shouldRemapUnsupportedThinkLevel && remappedUnsupportedThinkLevel) {
      sessionEntry.thinkingLevel = remappedUnsupportedThinkLevel;
    }
    if (modelSelection) {
      const applied = applyModelOverrideToSessionEntry({
        entry: sessionEntry,
        selection: modelSelection,
        profileOverride,
        markLiveSwitchPending: true,
      });
      const appliedRuntime = applyModelRuntimeDirective(sessionEntry, modelRuntimeResolution);
      modelSelectionUpdated = applied.updated || appliedRuntime.updated;
    }
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      const persistence = await persistSessionDirectiveSnapshot({
        storePath,
        sessionKey,
        initialEntry: initialSessionEntry,
        sessionEntry,
        sessionStore,
        hasModelSelection: Boolean(modelSelection),
        reassertLiveModelSwitchPending:
          modelSelectionUpdated && sessionEntry.liveModelSwitchPending === true,
        touchedFields: touchedSessionFields,
      });
      sessionChangesApplied = persistence.sessionChangesApplied;
      modelSelectionApplied = persistence.modelSelectionApplied;
    }
    if (modelSelection && !modelSelectionApplied) {
      sessionChangesApplied = false;
    }
    if (!sessionChangesApplied) {
      if (params.persistenceState) {
        params.persistenceState.sessionChangesApplied = false;
      }
      return {
        text: modelSelection
          ? "Model change was not applied because the session changed. Retry."
          : "Session settings were not applied because the session changed. Retry.",
      };
    }
    if (
      modelSelection &&
      modelSelectionApplied &&
      !modelSelection.isDefault &&
      !params.persistenceState &&
      params.canPersistStickyModelSelection === true
    ) {
      persistStickyModelSelectionBestEffort({
        agentId: activeAgentId,
        model: `${modelSelection.provider}/${modelSelection.model}`,
      });
    }
    if (modelSelection && modelSelectionUpdated && modelSelectionApplied && sessionKey) {
      triggerSessionPatchHook({
        cfg: params.cfg,
        sessionEntry: appliedSessionEntry,
        sessionKey,
        patch: {
          key: sessionKey,
          model:
            directives.rawModelDirective ?? `${modelSelection.provider}/${modelSelection.model}`,
        },
      });
      // `/model` should retarget queued/future work without interrupting the
      // active run. Refresh queued followups so they pick up the persisted
      // selection once the current turn finishes.
      refreshQueuedFollowupSession({
        key: sessionKey,
        nextProvider: modelSelection.provider,
        nextModel: modelSelection.model,
        nextRouteResolution: "resolved",
        nextModelOverrideSource: "user",
        nextAuthProfileId: appliedSessionEntry.authProfileOverride,
        nextAuthProfileIdSource: appliedSessionEntry.authProfileOverrideSource,
        nextThinking: {
          level: appliedSessionEntry.thinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: resolveEffectiveAgentRuntime({
            cfg: params.cfg,
            provider: modelSelection.provider,
            modelId: modelSelection.model,
            agentId: activeAgentId,
            sessionKey: runtimePolicySessionKey,
            sessionEntry: appliedSessionEntry,
          }),
        },
      });
    }
  }
  if (modelSelection && modelSelectionApplied) {
    const nextLabel = `${modelSelection.provider}/${modelSelection.model}`;
    if (nextLabel !== initialModelLabel) {
      enqueueSystemEvent(formatModelSwitchEvent(nextLabel, modelSelection.alias), {
        sessionKey,
        contextKey: `model:${nextLabel}`,
      });
    }
  }
  enqueueModeSwitchEvents({
    enqueueSystemEvent,
    sessionEntry: appliedSessionEntry,
    sessionKey,
    elevatedChanged,
    reasoningChanged,
  });

  const parts: string[] = [];
  if (directives.clearThinkLevel) {
    parts.push("Thinking level reset to default.");
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    const displayedThinkLevel = resolvedDirectiveThinkLevel ?? directives.thinkLevel;
    parts.push(
      displayedThinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${displayedThinkLevel}.`,
    );
    if (directives.thinkLevel === "max" && displayedThinkLevel !== "max") {
      parts.push(
        `max not supported for ${resolvedProvider}/${resolvedModel}; using ${displayedThinkLevel}.`,
      );
    }
  }
  if (directives.clearFastMode) {
    parts.push(formatDirectiveAck("Fast mode reset to default."));
  } else if (directives.hasFastDirective && directives.fastMode !== undefined) {
    parts.push(
      directives.fastMode === "auto"
        ? formatDirectiveAck("Fast mode set to auto.")
        : directives.fastMode
          ? formatDirectiveAck("Fast mode enabled.")
          : formatDirectiveAck("Fast mode disabled."),
    );
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    const message = allowPrivilegedPersistence
      ? DIRECTIVE_ACK_MESSAGES.verbose[directives.verboseLevel]
      : formatInternalVerboseCurrentReplyOnlyText();
    parts.push(formatDirectiveAck(message));
  }
  if (directives.hasTraceDirective && directives.traceLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.trace[directives.traceLevel]));
  }
  if (directives.hasVerboseDirective && directives.verboseLevel && !allowPrivilegedPersistence) {
    parts.push(formatDirectiveAck(formatInternalVerbosePersistenceDeniedText()));
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.reasoning[directives.reasoningLevel]));
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(formatDirectiveAck(DIRECTIVE_ACK_MESSAGES.elevated[directives.elevatedLevel]));
    if (shouldHintDirectRuntime) {
      parts.push(formatElevatedRuntimeHint());
    }
  }
  if (directives.hasExecDirective && directives.hasExecOptions && allowPrivilegedPersistence) {
    const execParts = Object.entries({
      host: directives.execHost,
      security: directives.execSecurity,
      ask: directives.execAsk,
      node: directives.execNode,
    })
      .filter(([, value]) => Boolean(value))
      .map(([key, value]) => `${key}=${value}`);
    if (execParts.length > 0) {
      parts.push(formatDirectiveAck(`Exec defaults set (${execParts.join(", ")}).`));
    }
  }
  if (directives.hasExecDirective && directives.hasExecOptions && !allowPrivilegedPersistence) {
    parts.push(formatDirectiveAck(formatInternalExecPersistenceDeniedText()));
  }
  if (modelSelection && modelSelectionApplied) {
    const label = `${modelSelection.provider}/${modelSelection.model}`;
    const labelWithAlias = modelSelection.alias ? `${modelSelection.alias} (${label})` : label;
    parts.push(
      modelSelection.isDefault
        ? `Model reset to default (${labelWithAlias}).`
        : `Model set to ${labelWithAlias} for this session.`,
    );
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
    if (modelRuntimeResolution.kind === "clear") {
      parts.push("Runtime reset to configured policy.");
    } else if (modelRuntimeResolution.kind === "set") {
      parts.push(`Runtime set to ${modelRuntimeResolution.runtime} for this session.`);
    }
  } else if (modelSelection) {
    parts.push("Model change was not applied because the session changed. Retry.");
  }
  // Report the model change before the thinking remap it triggered: the remap is a
  // consequence of the model switch, so the cause should be announced first.
  if (
    !directives.hasThinkDirective &&
    shouldRemapUnsupportedThinkLevel &&
    remappedUnsupportedThinkLevel
  ) {
    parts.push(
      `Thinking level set to ${remappedUnsupportedThinkLevel} (${nextThinkLevel} not supported for ${resolvedProvider}/${resolvedModel}).`,
    );
  }
  if (directives.hasQueueDirective && directives.queueMode) {
    parts.push(formatDirectiveAck(`Queue mode set to ${directives.queueMode}.`));
  } else if (directives.hasQueueDirective && directives.queueReset) {
    parts.push(formatDirectiveAck("Queue mode reset to default."));
  }
  if (directives.hasQueueDirective && typeof directives.debounceMs === "number") {
    parts.push(formatDirectiveAck(`Queue debounce set to ${directives.debounceMs}ms.`));
  }
  if (directives.hasQueueDirective && typeof directives.cap === "number") {
    parts.push(formatDirectiveAck(`Queue cap set to ${directives.cap}.`));
  }
  if (directives.hasQueueDirective && directives.dropPolicy) {
    parts.push(formatDirectiveAck(`Queue drop set to ${directives.dropPolicy}.`));
  }
  if (fastModeChanged) {
    const nextFastMode = directives.clearFastMode ? fastModeState.mode : sessionEntry.fastMode;
    const nextFastModeText =
      nextFastMode === "auto"
        ? "Fast mode set to auto."
        : `Fast mode ${nextFastMode ? "enabled" : "disabled"}.`;
    enqueueSystemEvent(nextFastModeText, {
      sessionKey,
      contextKey: `fast:${formatFastModeValue(nextFastMode)}`,
    });
  }
  const ack = parts.join(" ").trim();
  if (!ack && directives.hasStatusDirective) {
    return undefined;
  }
  return { text: ack || "OK." };
}
