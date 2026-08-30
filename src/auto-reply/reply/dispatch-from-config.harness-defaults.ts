import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import {
  resolveDefaultModelForAgent,
  resolveDefaultModelProviderForAgent,
} from "../../agents/model-selection-config.js";
import {
  createModelManifestPluginContext,
  resolveModelRefWithConfiguredAliases,
  type ModelManifestPluginContext,
} from "../../agents/model-selection-shared.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveStoredModelOverride } from "../../sessions/stored-model-overrides.js";
import {
  sessionDeliveryChannel,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import {
  loadSessionStoreEntry,
  resolveSessionStorePathCore,
} from "./dispatch-from-config.runtime.js";

type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

type HarnessDefaultParams = {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
};

type HarnessDefaultCandidate = {
  provider: string;
  model?: string;
};

export function createShouldEmitVerboseProgress(params: {
  agentId?: string;
  sessionKey?: string;
  storePath?: string;
  initialExplicitLevel?: string;
  fallbackLevel: string;
}) {
  const resolveCurrentExplicitLevel = () => {
    if (params.sessionKey && params.storePath) {
      try {
        const entry = loadSessionStoreEntry({
          ...(params.agentId ? { agentId: params.agentId } : {}),
          storePath: params.storePath,
          sessionKey: params.sessionKey,
          readConsistency: "latest",
          clone: false,
        });
        return normalizeVerboseLevel(entry?.verboseLevel ?? "");
      } catch {
        // Ignore transient store read failures and fall back to the current dispatch snapshot.
      }
    }
    return normalizeVerboseLevel(params.initialExplicitLevel ?? "");
  };
  const resolveLevel = () => {
    const explicitLevel = resolveCurrentExplicitLevel();
    if (explicitLevel) {
      return explicitLevel;
    }
    return normalizeVerboseLevel(params.fallbackLevel) ?? "off";
  };
  return {
    shouldEmit: () => resolveLevel() !== "off",
    shouldEmitFull: () => resolveLevel() === "full",
  };
}

function resolveHarnessDefaultChannel(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  const originatingChannel =
    typeof params.ctx.OriginatingChannel === "string" ? params.ctx.OriginatingChannel : undefined;

  return (
    sessionDeliveryChannel(params.entry) ??
    originatingChannel ??
    params.ctx.Provider ??
    params.ctx.Surface
  );
}

function resolveHarnessDefaultParentSessionKey(params: {
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
}): string | undefined {
  return (
    params.entry?.parentSessionKey ??
    params.ctx.ModelParentSessionKey ??
    params.ctx.ParentSessionKey
  );
}

export function resolveTurnModelOverride(
  replyOptions: { isHeartbeat?: boolean; heartbeatModelOverride?: string } | undefined,
): string | undefined {
  if (replyOptions?.isHeartbeat !== true) {
    return undefined;
  }
  return normalizeOptionalString(replyOptions.heartbeatModelOverride);
}

function resolveChannelModelInput(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  parentSessionKey?: string;
}): string | undefined {
  if (!params.cfg.channels?.modelByChannel) {
    return undefined;
  }

  const channel = resolveHarnessDefaultChannel({
    ctx: params.ctx,
    entry: params.entry,
  });
  return resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.entry?.groupId,
    groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
    groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
    groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
    parentSessionKey: params.parentSessionKey,
    directUserIds: [
      sessionDeliveryOrigin(params.entry)?.nativeDirectUserId,
      sessionDeliveryOrigin(params.entry)?.from,
      sessionDeliveryOrigin(params.entry)?.to,
      params.ctx.OriginatingTo,
      params.ctx.From,
      params.ctx.SenderId,
    ],
  })?.model;
}

function resolveStoredModelCandidate(params: {
  cfg: OpenClawConfig;
  manifestPluginContext: ModelManifestPluginContext;
  entry?: SessionEntry;
  parentSessionKey?: string;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
}): HarnessDefaultCandidate | undefined {
  const storedModelRef = resolveStoredModelOverride({
    config: params.cfg,
    agentId: params.sessionAgentId,
    manifestPluginContext: params.manifestPluginContext,
    loadSessionEntry: (sessionKey) => {
      const agentId = resolveSessionAgentId({
        sessionKey,
        config: params.cfg,
        fallbackAgentId: params.sessionAgentId,
      });
      const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
      return loadSessionStoreEntry({
        agentId,
        storePath,
        sessionKey,
        readConsistency: "latest",
        clone: false,
      });
    },
    sessionEntry: params.entry,
    sessionStore: params.sessionStore,
    sessionKey: params.sessionKey,
    parentSessionKey: params.parentSessionKey,
  });
  if (!storedModelRef) {
    return undefined;
  }
  return {
    provider:
      storedModelRef.provider ??
      resolveDefaultModelProviderForAgent({
        cfg: params.cfg,
        agentId: params.sessionAgentId,
        manifestPluginContext: params.manifestPluginContext,
      }),
    model: storedModelRef.model,
  };
}

/**
 * Resolves the configured visible-replies mode plus the guarded harness
 * default. One owner for dispatch and synthetic-turn binding facts: both must
 * derive the same session-stable delivery mode or CLI session bindings
 * ping-pong across turn kinds (#121485).
 */
export function resolveVisibleRepliesPolicy(params: HarnessDefaultParams & { chatType?: string }): {
  configuredVisibleReplies?: "automatic" | "message_tool";
  harnessDefaultVisibleReplies?: "automatic" | "message_tool";
} {
  const configuredVisibleReplies =
    params.chatType === "group" || params.chatType === "channel"
      ? (params.cfg.messages?.groupChat?.visibleReplies ?? params.cfg.messages?.visibleReplies)
      : params.cfg.messages?.visibleReplies;
  const harnessDefaultVisibleReplies =
    configuredVisibleReplies === undefined &&
    params.chatType !== "group" &&
    params.chatType !== "channel"
      ? resolveHarnessSourceVisibleRepliesDefault(params)
      : undefined;
  return { configuredVisibleReplies, harnessDefaultVisibleReplies };
}

function resolveHarnessSourceVisibleRepliesDefault(
  params: HarnessDefaultParams,
): HarnessSourceVisibleRepliesDefault | undefined {
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return undefined;
  }
  try {
    const modelContext = {
      cfg: params.cfg,
      agentId: params.sessionAgentId,
      manifestPluginContext: createModelManifestPluginContext({
        cfg: params.cfg,
        agentId: params.sessionAgentId,
      }),
    };
    let defaultProvider: string | undefined;
    const resolveModelInput = (raw: string | undefined) =>
      raw
        ? resolveModelRefWithConfiguredAliases({
            ...modelContext,
            raw,
            defaultProvider: (defaultProvider ??=
              resolveDefaultModelProviderForAgent(modelContext)),
          })
        : null;
    const parentSessionKey = resolveHarnessDefaultParentSessionKey(params);
    const resolveCandidateDefault = (candidate: HarnessDefaultCandidate) => {
      const agentHarnessRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
        provider: candidate.provider,
        entry: params.entry,
        cfg: params.cfg,
      });
      const harness = selectAgentHarness({
        provider: candidate.provider,
        modelId: candidate.model,
        config: params.cfg,
        agentId: params.sessionAgentId,
        sessionKey: params.sessionKey,
        agentHarnessId:
          params.entry?.modelSelectionLocked === true ? params.entry.agentHarnessId : undefined,
        agentHarnessRuntimeOverride,
      });
      return (
        harness.deliveryDefaults?.visibleReplies ?? harness.deliveryDefaults?.sourceVisibleReplies
      );
    };
    // Resolve in priority order. Unselected model hooks can be expensive or fail,
    // and must not suppress the delivery policy owned by the winning model.
    const selectedModelCandidate =
      resolveModelInput(params.turnModelOverride) ??
      resolveStoredModelCandidate({
        ...params,
        parentSessionKey,
        manifestPluginContext: modelContext.manifestPluginContext,
      }) ??
      resolveModelInput(resolveChannelModelInput({ ...params, parentSessionKey }));
    if (selectedModelCandidate) {
      return resolveCandidateDefault(selectedModelCandidate);
    }
    const sourceProvider = normalizeOptionalString(
      sessionDeliveryOrigin(params.entry)?.provider ?? params.ctx.Provider ?? params.ctx.Surface,
    );
    if (sourceProvider) {
      const sourceDefault = resolveCandidateDefault({ provider: sourceProvider });
      if (sourceDefault) {
        return sourceDefault;
      }
    }
    return resolveCandidateDefault(resolveDefaultModelForAgent(modelContext));
  } catch (error) {
    logVerbose(
      `dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
