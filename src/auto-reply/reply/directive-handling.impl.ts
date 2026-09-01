/** Applies directive-only command state changes without running the agent. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { renderExecTargetLabel } from "../../agents/bash-tools.exec-runtime.js";
import { resolveExecDefaults } from "../../agents/exec-defaults.js";
import {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeValue,
  resolveFastModeState,
} from "../../agents/fast-mode.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyModelOverrideWithAuthProfileCompatibility } from "../../sessions/auth-profile-preservation.js";
import {
  isModelSelectionLocked,
  MODEL_SELECTION_LOCKED_MESSAGE,
} from "../../sessions/model-overrides.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  formatThinkingLevels,
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
} from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import { applyModelRuntimeDirective } from "./directive-handling.model-runtime.js";
import { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import { maybeHandleUnexpectedNativeDirectiveArguments } from "./directive-handling.native.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  acknowledgeIgnoredSessionDirective,
  applySessionDirectiveFields,
  canPersistSessionDirectiveDefaults,
  DIRECTIVE_ACK_MESSAGES,
  type IgnoredSessionDirectiveFlag,
  formatDirectiveAck,
  formatElevatedRuntimeHint,
  formatElevatedUnavailableText,
  formatInternalExecPersistenceDeniedText,
  formatInternalVerboseCurrentReplyOnlyText,
  formatInternalVerbosePersistenceDeniedText,
  formatModelSelectionScopeAck,
  enqueueModeSwitchEvents,
  persistSessionDirectiveSnapshot,
  rejectSessionDirectiveTransaction,
  resolveDirectiveTouchedSessionFields,
  withOptions,
} from "./directive-handling.shared.js";
import { resolveDirectiveRuntimeContext } from "./directive-runtime-context.js";
import type { ReasoningLevel, ThinkLevel } from "./directives.js";
import {
  findSelectedCatalogEntry,
  prepareModelSelectionRuntime,
} from "./model-runtime-normalization.js";
import { refreshQueuedFollowupSession } from "./queue.js";

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
  const allowPrivilegedPersistence = canPersistSessionDirectiveDefaults(params);
  const rejectModelTransaction = (errorText: string) =>
    rejectSessionDirectiveTransaction(params.persistenceState, errorText);
  const acknowledgeIgnoredDirective = (
    reply: ReplyPayload,
    ignoredDirective: IgnoredSessionDirectiveFlag,
  ) =>
    acknowledgeIgnoredSessionDirective({
      reply,
      directives,
      ignoredDirective,
      persistenceState: params.persistenceState,
      allowPrivilegedPersistence,
      applyRemainingDirectives: (remainingDirectives) =>
        handleDirectiveOnly({ ...params, directives: remainingDirectives }),
    });
  const delegatedTraceAllowed = (params.gatewayClientScopes ?? []).includes("operator.admin");
  if (directives.hasTraceDirective && !params.senderIsOwner && !delegatedTraceAllowed) {
    return acknowledgeIgnoredDirective(
      { text: "❌ /trace is restricted to owners and gateway clients with operator.admin scope." },
      "hasTraceDirective",
    );
  }
  const { activeAgentId, agentDir, runtimePolicySessionKey, runtimeIsSandboxed } =
    resolveDirectiveRuntimeContext(params);
  const shouldHintDirectRuntime = directives.hasElevatedDirective && !runtimeIsSandboxed;
  let thinkingCatalog =
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
    return acknowledgeIgnoredDirective(modelInfo, "hasModelDirective");
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
    modelPolicy: params.modelPolicy,
  });
  if (modelResolution.errorText) {
    return rejectModelTransaction(modelResolution.errorText);
  }
  const modelSelection = modelResolution.modelSelection;
  const profileOverride = modelResolution.profileOverride;
  if (modelSelection && isModelSelectionLocked(sessionEntry)) {
    return rejectModelTransaction(MODEL_SELECTION_LOCKED_MESSAGE);
  }

  const resolvedProvider = modelSelection?.provider ?? provider;
  const resolvedModel = modelSelection?.model ?? model;
  let modelRuntimeResolution: Parameters<typeof applyModelRuntimeDirective>[1] = {
    kind: "unchanged",
  };
  if (modelSelection) {
    const prepared = await prepareModelSelectionRuntime({
      cfg: params.cfg,
      agentId: activeAgentId,
      provider: resolvedProvider,
      model: resolvedModel,
      catalog: thinkingCatalog ?? [],
      rawRuntime: directives.rawModelRuntime,
      sessionEntry,
    });
    if (prepared.status === "rejected") {
      return rejectModelTransaction(prepared.message);
    }
    thinkingCatalog = prepared.catalog;
    modelRuntimeResolution = prepared.runtime;
  }
  const prospectiveSessionEntry = { ...sessionEntry };
  applyModelRuntimeDirective(prospectiveSessionEntry, modelRuntimeResolution);
  const selectedCatalogEntry = findSelectedCatalogEntry({
    catalog: thinkingCatalog,
    provider: resolvedProvider,
    model: resolvedModel,
  });
  const resolveThinkingRuntime = (entry: typeof sessionEntry) =>
    resolveEffectiveAgentRuntime({
      cfg: params.cfg,
      provider: resolvedProvider,
      modelId: resolvedModel,
      modelApi: selectedCatalogEntry?.api,
      modelBaseUrl: selectedCatalogEntry?.baseUrl,
      agentId: activeAgentId,
      sessionKey: runtimePolicySessionKey,
      sessionEntry: entry,
    });
  const thinkingRuntime = resolveThinkingRuntime(prospectiveSessionEntry);
  const thinkingPolicy = {
    provider: resolvedProvider,
    model: resolvedModel,
    catalog: thinkingCatalog,
    agentRuntime: thinkingRuntime,
  };
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
        ...thinkingPolicy,
        level: currentThinkLevel ?? "off",
      });
      return acknowledgeIgnoredDirective(
        {
          text: withOptions(
            `Current thinking level: ${level}.`,
            `default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}`,
          ),
        },
        "hasThinkDirective",
      );
    }
    return acknowledgeIgnoredDirective(
      {
        text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: default, ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
      },
      "hasThinkDirective",
    );
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    return acknowledgeIgnoredDirective(
      {
        text: directives.rawVerboseLevel
          ? `Unrecognized verbose level "${directives.rawVerboseLevel}". Valid levels: off, on, full.`
          : withOptions(`Current verbose level: ${currentVerboseLevel ?? "off"}.`, "on, full, off"),
      },
      "hasVerboseDirective",
    );
  }
  if (directives.hasTraceDirective && !directives.traceLevel) {
    return acknowledgeIgnoredDirective(
      {
        text: directives.rawTraceLevel
          ? `Unrecognized trace level "${directives.rawTraceLevel}". Valid levels: off, on, raw.`
          : withOptions(
              `Current trace level: ${sessionEntry.traceLevel ?? "off"}.`,
              "on, off, raw",
            ),
      },
      "hasTraceDirective",
    );
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
      return acknowledgeIgnoredDirective(
        {
          text: isFastStatus
            ? statusText
            : withOptions(
                statusText,
                formatFastModeCommandOptions({
                  fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
                }),
              ),
        },
        "hasFastDirective",
      );
    }
    return acknowledgeIgnoredDirective(
      {
        text: `Unrecognized fast mode "${directives.rawFastMode}". Valid levels: on, off, auto, default, status.`,
      },
      "hasFastDirective",
    );
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    return acknowledgeIgnoredDirective(
      {
        text: directives.rawReasoningLevel
          ? `Unrecognized reasoning level "${directives.rawReasoningLevel}". Valid levels: on, off, stream.`
          : withOptions(
              `Current reasoning level: ${currentReasoningLevel ?? "off"}.`,
              "on, off, stream",
            ),
      },
      "hasReasoningDirective",
    );
  }
  if (directives.hasElevatedDirective && !directives.elevatedLevel) {
    if (!directives.rawElevatedLevel) {
      if (!elevatedEnabled || !elevatedAllowed) {
        return acknowledgeIgnoredDirective(
          {
            text: formatElevatedUnavailableText({
              runtimeSandboxed: runtimeIsSandboxed,
              failures: params.elevatedFailures,
              sessionKey: params.sessionKey,
            }),
          },
          "hasElevatedDirective",
        );
      }
      const level = currentElevatedLevel ?? "off";
      return acknowledgeIgnoredDirective(
        {
          text: [
            withOptions(`Current elevated level: ${level}.`, "on, off, ask, full"),
            shouldHintDirectRuntime ? formatElevatedRuntimeHint() : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
        "hasElevatedDirective",
      );
    }
    return acknowledgeIgnoredDirective(
      {
        text: `Unrecognized elevated level "${directives.rawElevatedLevel}". Valid levels: off, on, ask, full.`,
      },
      "hasElevatedDirective",
    );
  }
  if (directives.hasElevatedDirective && (!elevatedEnabled || !elevatedAllowed)) {
    return acknowledgeIgnoredDirective(
      {
        text: formatElevatedUnavailableText({
          runtimeSandboxed: runtimeIsSandboxed,
          failures: params.elevatedFailures,
          sessionKey: params.sessionKey,
        }),
      },
      "hasElevatedDirective",
    );
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
      return acknowledgeIgnoredDirective({ text: invalidExecMessage }, "hasExecDirective");
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
      return acknowledgeIgnoredDirective(
        {
          text: withOptions(
            `Current exec defaults: host=${renderExecTargetLabel(execDefaults.host)}, effective=${execDefaults.effectiveHost}, security=${execDefaults.security}, ask=${execDefaults.ask}, ${nodeLabel}.`,
            "host=auto|sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>",
          ),
        },
        "hasExecDirective",
      );
    }
  }

  const queueAck = maybeHandleQueueDirective({
    directives,
    cfg: params.cfg,
    channel: provider,
    sessionEntry,
  });
  if (queueAck) {
    return acknowledgeIgnoredDirective(queueAck, "hasQueueDirective");
  }

  const unexpectedNativeArguments = maybeHandleUnexpectedNativeDirectiveArguments(directives);
  if (unexpectedNativeArguments) {
    return unexpectedNativeArguments;
  }

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel &&
    !isThinkingLevelSupported({
      ...thinkingPolicy,
      level: directives.thinkLevel,
    })
  ) {
    return rejectModelTransaction(
      `Thinking level "${directives.thinkLevel}" is not supported for ${resolvedProvider}/${resolvedModel}. Use one of: ${formatThinkingLevels(resolvedProvider, resolvedModel, ", ", thinkingCatalog, thinkingRuntime)}.`,
    );
  }

  const nextThinkLevel = directives.hasThinkDirective
    ? directives.thinkLevel
    : ((sessionEntry?.thinkingLevel as ThinkLevel | undefined) ?? currentThinkLevel);
  const remappedUnsupportedThinkLevel =
    !directives.hasThinkDirective && nextThinkLevel
      ? resolveSupportedThinkingLevel({
          ...thinkingPolicy,
          level: nextThinkLevel,
        })
      : undefined;
  const shouldRemapUnsupportedThinkLevel =
    Boolean(remappedUnsupportedThinkLevel) && remappedUnsupportedThinkLevel !== nextThinkLevel;

  const prevReasoningLevel =
    currentReasoningLevel ?? (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  const elevatedChanged =
    directives.hasElevatedDirective &&
    directives.elevatedLevel !== undefined &&
    directives.elevatedLevel !== (currentElevatedLevel ?? sessionEntry.elevatedLevel ?? "off") &&
    elevatedEnabled &&
    elevatedAllowed;
  let modelSelectionUpdated = false;
  let configuredDefaultUpdate: ReturnType<typeof persistStickyModelSelectionBestEffort> | undefined;
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
      const applied = applyModelOverrideWithAuthProfileCompatibility({
        cfg: params.cfg,
        agentDir,
        entry: sessionEntry,
        currentProvider: provider,
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
      if (persistence.status !== "applied") {
        const errorText =
          persistence.status === "model-selection-locked"
            ? MODEL_SELECTION_LOCKED_MESSAGE
            : modelSelection
              ? "Model change was not applied because the session changed. Retry."
              : "Session settings were not applied because the session changed. Retry.";
        return rejectModelTransaction(errorText);
      }
    }
    if (
      modelSelection &&
      (!modelSelection.isDefault || params.stickyModelSelectionTarget) &&
      params.canPersistStickyModelSelection === true
    ) {
      configuredDefaultUpdate = persistStickyModelSelectionBestEffort({
        agentId: activeAgentId,
        model: `${modelSelection.provider}/${modelSelection.model}`,
        ...(params.stickyModelSelectionTarget ? { target: params.stickyModelSelectionTarget } : {}),
      });
    }
    if (modelSelection && modelSelectionUpdated && sessionKey) {
      emitSessionLifecycleEvent({ sessionKey, agentId: activeAgentId, reason: "patch" });
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
        nextModelOverrideSource: modelSelection.isDefault ? undefined : "user",
        nextAuthProfileId: appliedSessionEntry.authProfileOverride,
        nextAuthProfileIdSource: resolveSessionAuthProfileOverrideSource(appliedSessionEntry),
        nextThinking: {
          level: appliedSessionEntry.thinkingLevel,
          catalog: thinkingCatalog,
          agentRuntime: resolveThinkingRuntime(appliedSessionEntry),
        },
      });
    }
  }
  if (modelSelection) {
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
  if (params.persistenceState) {
    params.persistenceState.outcome = {
      kind: "applied",
      provider: resolvedProvider,
      model: resolvedModel,
      modelCatalog: thinkingCatalog,
    };
  }

  const parts: string[] = [];
  if (directives.clearThinkLevel) {
    parts.push("Thinking level reset to default.");
  } else if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
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
  if (directives.hasExecDirective && directives.hasExecOptions) {
    for (const [label, options] of [
      [
        allowPrivilegedPersistence && "Exec defaults set",
        { host: directives.execHost, node: directives.execNode },
      ],
      [
        "Exec policy for this run only",
        { security: directives.execSecurity, ask: directives.execAsk },
      ],
    ] as const) {
      const execParts = Object.entries(options)
        .filter(([, value]) => Boolean(value))
        .map(([key, value]) => `${key}=${value}`);
      if (execParts.length > 0) {
        const message = label
          ? `${label} (${execParts.join(", ")}).`
          : formatInternalExecPersistenceDeniedText();
        parts.push(formatDirectiveAck(message));
      }
    }
  }
  if (modelSelection) {
    const label = `${modelSelection.provider}/${modelSelection.model}`;
    const labelWithAlias = modelSelection.alias ? `${modelSelection.alias} (${label})` : label;
    parts.push(
      formatModelSelectionScopeAck({
        isDefault: modelSelection.isDefault,
        label: labelWithAlias,
        configuredDefaultUpdate,
        ...(params.stickyModelSelectionTarget
          ? { stickyModelSelectionTarget: params.stickyModelSelectionTarget }
          : {}),
      }),
    );
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
    if (modelRuntimeResolution.kind === "clear") {
      parts.push("Runtime reset to configured policy.");
    } else if (modelRuntimeResolution.kind === "set") {
      parts.push(`Runtime set to ${modelRuntimeResolution.runtime} for this session.`);
    }
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
