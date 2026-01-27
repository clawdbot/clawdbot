import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import type { MoltbotConfig } from "../../config/config.js";
import { type SessionEntry, updateSessionStore } from "../../config/sessions.js";
import type { ExecAsk, ExecHost, ExecSecurity } from "../../infra/exec-approvals.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { applyVerboseOverride } from "../../sessions/level-overrides.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { formatThinkingLevels, formatXHighModelHint, supportsXHighThinking } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import {
  maybeHandleModelDirectiveInfo,
  resolveModelSelectionFromDirective,
} from "./directive-handling.model.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { maybeHandleQueueDirective } from "./directive-handling.queue-validation.js";
import {
  formatDirectiveAck,
  formatElevatedEvent,
  formatElevatedRuntimeHint,
  formatElevatedUnavailableText,
  formatReasoningEvent,
  withOptions,
} from "./directive-handling.shared.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "./directives.js";

function resolveExecDefaults(params: {
  cfg: MoltbotConfig;
  sessionEntry?: SessionEntry;
  agentId?: string;
}): { host: ExecHost; security: ExecSecurity; ask: ExecAsk; node?: string } {
  const globalExec = params.cfg.tools?.exec;
  const agentExec = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.tools?.exec
    : undefined;
  return {
    host:
      (params.sessionEntry?.execHost as ExecHost | undefined) ??
      (agentExec?.host as ExecHost | undefined) ??
      (globalExec?.host as ExecHost | undefined) ??
      "sandbox",
    security:
      (params.sessionEntry?.execSecurity as ExecSecurity | undefined) ??
      (agentExec?.security as ExecSecurity | undefined) ??
      (globalExec?.security as ExecSecurity | undefined) ??
      "deny",
    ask:
      (params.sessionEntry?.execAsk as ExecAsk | undefined) ??
      (agentExec?.ask as ExecAsk | undefined) ??
      (globalExec?.ask as ExecAsk | undefined) ??
      "on-miss",
    node:
      (params.sessionEntry?.execNode as string | undefined) ?? agentExec?.node ?? globalExec?.node,
  };
}

export async function handleDirectiveOnly(params: {
  cfg: MoltbotConfig;
  directives: InlineDirectives;
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures?: Array<{ gate: string; key: string }>;
  messageProviderKey?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
  allowedModelCatalog: Awaited<
    ReturnType<typeof import("../../agents/model-catalog.js").loadModelCatalog>
  >;
  resetModelOverride: boolean;
  provider: string;
  model: string;
  initialModelLabel: string;
  formatModelSwitchEvent: (label: string, alias?: string) => string;
  currentThinkLevel?: ThinkLevel;
  currentVerboseLevel?: VerboseLevel;
  currentReasoningLevel?: ReasoningLevel;
  currentElevatedLevel?: ElevatedLevel;
}): Promise<ReplyPayload | undefined> {
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
    allowedModelKeys,
    allowedModelCatalog,
    resetModelOverride,
    provider,
    model,
    initialModelLabel,
    formatModelSwitchEvent,
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  } = params;
  const activeAgentId = resolveSessionAgentId({
    sessionKey: params.sessionKey,
    config: params.cfg,
  });
  const agentDir = resolveAgentDir(params.cfg, activeAgentId);
  const runtimeIsSandboxed = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  }).sandboxed;
  const shouldHintDirectRuntime = directives.hasElevatedDirective && !runtimeIsSandboxed;

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
    allowedModelCatalog,
    resetModelOverride,
  });
  if (modelInfo) return modelInfo;

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
  });
  if (modelResolution.errorText) return { text: modelResolution.errorText };
  const modelSelection = modelResolution.modelSelection;
  const profileOverride = modelResolution.profileOverride;

  const resolvedProvider = modelSelection?.provider ?? provider;
  const resolvedModel = modelSelection?.model ?? model;

  if (directives.hasThinkDirective && !directives.thinkLevel) {
    // If no argument was provided, show the current level
    if (!directives.rawThinkLevel) {
      const level = currentThinkLevel ?? "off";
      return {
        text: withOptions(
          `Current thinking level: ${level}.`,
          formatThinkingLevels(resolvedProvider, resolvedModel),
        ),
      };
    }
    return {
      text: `Unrecognized thinking level "${directives.rawThinkLevel}". Valid levels: ${formatThinkingLevels(resolvedProvider, resolvedModel)}.`,
    };
  }
  if (directives.hasVerboseDirective && !directives.verboseLevel) {
    if (!directives.rawVerboseLevel) {
      const level = currentVerboseLevel ?? "off";
      return {
        text: withOptions(`Current verbose level: ${level}.`, "on, full, off"),
      };
    }
    return {
      text: `Unrecognized verbose level "${directives.rawVerboseLevel}". Valid levels: off, on, full.`,
    };
  }
  if (directives.hasReasoningDirective && !directives.reasoningLevel) {
    if (!directives.rawReasoningLevel) {
      const level = currentReasoningLevel ?? "off";
      return {
        text: withOptions(`Current reasoning level: ${level}.`, "on, off, stream"),
      };
    }
    return {
      text: `Unrecognized reasoning level "${directives.rawReasoningLevel}". Valid levels: on, off, stream.`,
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
    if (directives.invalidExecHost) {
      return {
        text: `Unrecognized exec host "${directives.rawExecHost ?? ""}". Valid hosts: sandbox, gateway, node.`,
      };
    }
    if (directives.invalidExecSecurity) {
      return {
        text: `Unrecognized exec security "${directives.rawExecSecurity ?? ""}". Valid: deny, allowlist, full.`,
      };
    }
    if (directives.invalidExecAsk) {
      return {
        text: `Unrecognized exec ask "${directives.rawExecAsk ?? ""}". Valid: off, on-miss, always.`,
      };
    }
    if (directives.invalidExecNode) {
      return {
        text: "Exec node requires a value.",
      };
    }
    if (!directives.hasExecOptions) {
      const execDefaults = resolveExecDefaults({
        cfg: params.cfg,
        sessionEntry,
        agentId: activeAgentId,
      });
      const nodeLabel = execDefaults.node ? `node=${execDefaults.node}` : "node=(unset)";
      return {
        text: withOptions(
          `Current exec defaults: host=${execDefaults.host}, security=${execDefaults.security}, ask=${execDefaults.ask}, ${nodeLabel}.`,
          "host=sandbox|gateway|node, security=deny|allowlist|full, ask=off|on-miss|always, node=<id>",
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
  if (queueAck) return queueAck;

  if (
    directives.hasThinkDirective &&
    directives.thinkLevel === "xhigh" &&
    !supportsXHighThinking(resolvedProvider, resolvedModel)
  ) {
    return {
      text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}.`,
    };
  }

  const nextThinkLevel = directives.hasThinkDirective
    ? directives.thinkLevel
    : ((sessionEntry?.thinkingLevel as ThinkLevel | undefined) ?? currentThinkLevel);
  const shouldDowngradeXHigh =
    !directives.hasThinkDirective &&
    nextThinkLevel === "xhigh" &&
    !supportsXHighThinking(resolvedProvider, resolvedModel);

  const prevElevatedLevel =
    currentElevatedLevel ??
    (sessionEntry.elevatedLevel as ElevatedLevel | undefined) ??
    (elevatedAllowed ? ("on" as ElevatedLevel) : ("off" as ElevatedLevel));
  const prevReasoningLevel =
    currentReasoningLevel ?? (sessionEntry.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  let elevatedChanged =
    directives.hasElevatedDirective &&
    directives.elevatedLevel !== undefined &&
    elevatedEnabled &&
    elevatedAllowed;
  let reasoningChanged =
    directives.hasReasoningDirective && directives.reasoningLevel !== undefined;
  if (directives.hasThinkDirective && directives.thinkLevel) {
    if (directives.thinkLevel === "off") delete sessionEntry.thinkingLevel;
    else sessionEntry.thinkingLevel = directives.thinkLevel;
  }
  if (shouldDowngradeXHigh) {
    sessionEntry.thinkingLevel = "high";
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    applyVerboseOverride(sessionEntry, directives.verboseLevel);
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    if (directives.reasoningLevel === "off") delete sessionEntry.reasoningLevel;
    else sessionEntry.reasoningLevel = directives.reasoningLevel;
    reasoningChanged =
      directives.reasoningLevel !== prevReasoningLevel && directives.reasoningLevel !== undefined;
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    // Unlike other toggles, elevated defaults can be "on".
    // Persist "off" explicitly so `/elevated off` actually overrides defaults.
    sessionEntry.elevatedLevel = directives.elevatedLevel;
    elevatedChanged =
      elevatedChanged ||
      (directives.elevatedLevel !== prevElevatedLevel && directives.elevatedLevel !== undefined);
  }
  if (directives.hasExecDirective && directives.hasExecOptions) {
    if (directives.execHost) {
      sessionEntry.execHost = directives.execHost;
    }
    if (directives.execSecurity) {
      sessionEntry.execSecurity = directives.execSecurity;
    }
    if (directives.execAsk) {
      sessionEntry.execAsk = directives.execAsk;
    }
    if (directives.execNode) {
      sessionEntry.execNode = directives.execNode;
    }
  }
  if (modelSelection) {
    applyModelOverrideToSessionEntry({
      entry: sessionEntry,
      selection: modelSelection,
      profileOverride,
    });
  }
  if (directives.hasQueueDirective && directives.queueReset) {
    delete sessionEntry.queueMode;
    delete sessionEntry.queueDebounceMs;
    delete sessionEntry.queueCap;
    delete sessionEntry.queueDrop;
  } else if (directives.hasQueueDirective) {
    if (directives.queueMode) sessionEntry.queueMode = directives.queueMode;
    if (typeof directives.debounceMs === "number") {
      sessionEntry.queueDebounceMs = directives.debounceMs;
    }
    if (typeof directives.cap === "number") {
      sessionEntry.queueCap = directives.cap;
    }
    if (directives.dropPolicy) {
      sessionEntry.queueDrop = directives.dropPolicy;
    }
  }
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    });
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
  if (elevatedChanged) {
    const nextElevated = (sessionEntry.elevatedLevel ?? "off") as ElevatedLevel;
    enqueueSystemEvent(formatElevatedEvent(nextElevated), {
      sessionKey,
      contextKey: "mode:elevated",
    });
  }
  if (reasoningChanged) {
    const nextReasoning = (sessionEntry.reasoningLevel ?? "off") as ReasoningLevel;
    enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
      sessionKey,
      contextKey: "mode:reasoning",
    });
  }

  const parts: string[] = [];
  if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(
      directives.thinkLevel === "off"
        ? "Thinking disabled."
        : `Thinking level set to ${directives.thinkLevel}.`,
    );
  }
  if (directives.hasVerboseDirective && directives.verboseLevel) {
    parts.push(
      directives.verboseLevel === "off"
        ? formatDirectiveAck("Verbose logging disabled.")
        : directives.verboseLevel === "full"
          ? formatDirectiveAck("Verbose logging set to full.")
          : formatDirectiveAck("Verbose logging enabled."),
    );
  }
  if (directives.hasReasoningDirective && directives.reasoningLevel) {
    parts.push(
      directives.reasoningLevel === "off"
        ? formatDirectiveAck("Reasoning visibility disabled.")
        : directives.reasoningLevel === "stream"
          ? formatDirectiveAck("Reasoning stream enabled (Telegram only).")
          : formatDirectiveAck("Reasoning visibility enabled."),
    );
  }
  if (directives.hasElevatedDirective && directives.elevatedLevel) {
    parts.push(
      directives.elevatedLevel === "off"
        ? formatDirectiveAck("Elevated mode disabled.")
        : directives.elevatedLevel === "full"
          ? formatDirectiveAck("Elevated mode set to full (auto-approve).")
          : formatDirectiveAck("Elevated mode set to ask (approvals may still apply)."),
    );
    if (shouldHintDirectRuntime) parts.push(formatElevatedRuntimeHint());
  }
  if (directives.hasExecDirective && directives.hasExecOptions) {
    const execParts: string[] = [];
    if (directives.execHost) execParts.push(`host=${directives.execHost}`);
    if (directives.execSecurity) execParts.push(`security=${directives.execSecurity}`);
    if (directives.execAsk) execParts.push(`ask=${directives.execAsk}`);
    if (directives.execNode) execParts.push(`node=${directives.execNode}`);
    if (execParts.length > 0) {
      parts.push(formatDirectiveAck(`Exec defaults set (${execParts.join(", ")}).`));
    }
  }
  if (shouldDowngradeXHigh) {
    parts.push(
      `Thinking level set to high (xhigh not supported for ${resolvedProvider}/${resolvedModel}).`,
    );
  }
  if (modelSelection) {
    const label = `${modelSelection.provider}/${modelSelection.model}`;
    const labelWithAlias = modelSelection.alias ? `${modelSelection.alias} (${label})` : label;
    parts.push(
      modelSelection.isDefault
        ? `Model reset to default (${labelWithAlias}).`
        : `Model set to ${labelWithAlias}.`,
    );
    if (profileOverride) {
      parts.push(`Auth profile set to ${profileOverride}.`);
    }
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
  const ack = parts.join(" ").trim();
  if (!ack && directives.hasStatusDirective) return undefined;
  return { text: ack || "OK." };
}
