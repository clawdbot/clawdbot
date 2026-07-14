import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  type ModelAliasIndex,
} from "../../agents/model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { FinalizedMsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { loadSessionStoreEntry, resolveStorePath } from "./dispatch-from-config.runtime.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";

type HarnessSourceVisibleRepliesDefault = "automatic" | "message_tool";

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
    params.entry?.channel ??
    params.entry?.origin?.provider ??
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
  replyOptions: DispatchFromConfigParams["replyOptions"],
): string | undefined {
  if (replyOptions?.isHeartbeat !== true) {
    return undefined;
  }
  return normalizeOptionalString(replyOptions.heartbeatModelOverride);
}

function resolveChannelModelCandidate(params: {
  aliasIndex: ModelAliasIndex;
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.cfg.channels?.modelByChannel) {
    return undefined;
  }

  const channel = resolveHarnessDefaultChannel({
    ctx: params.ctx,
    entry: params.entry,
  });
  const channelModelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.entry?.groupId,
    groupChatType: params.entry?.chatType ?? params.ctx.ChatType,
    groupChannel: params.entry?.groupChannel ?? params.ctx.GroupChannel,
    groupSubject: params.entry?.subject ?? params.ctx.GroupSubject,
    parentSessionKey: params.parentSessionKey,
    directUserIds: [
      params.entry?.origin?.nativeDirectUserId,
      params.entry?.origin?.from,
      params.entry?.origin?.to,
      params.ctx.OriginatingTo,
      params.ctx.From,
      params.ctx.SenderId,
    ],
  });
  if (!channelModelOverride) {
    return undefined;
  }

  return resolveModelRefFromString({
    raw: channelModelOverride.model,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

function resolveStoredModelCandidate(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  entry?: SessionEntry;
  parentSessionKey?: string;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
}): HarnessDefaultCandidate | undefined {
  const storedModelRef = resolveStoredModelOverride({
    loadSessionEntry: (sessionKey) => {
      const agentId = resolveSessionAgentId({
        sessionKey,
        config: params.cfg,
        fallbackAgentId: params.sessionAgentId,
      });
      const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
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
    defaultProvider: params.defaultProvider,
  });
  if (!storedModelRef) {
    return undefined;
  }
  return {
    provider: storedModelRef.provider ?? params.defaultProvider,
    model: storedModelRef.model,
  };
}

function resolveModelOverrideCandidate(params: {
  aliasIndex: ModelAliasIndex;
  defaultProvider: string;
  modelOverride?: string;
}): HarnessDefaultCandidate | undefined {
  if (!params.modelOverride) {
    return undefined;
  }
  return resolveModelRefFromString({
    raw: params.modelOverride,
    defaultProvider: params.defaultProvider,
    aliasIndex: params.aliasIndex,
  })?.ref;
}

export function resolveHarnessSourceVisibleRepliesDefault(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
  entry?: SessionEntry;
  sessionAgentId: string;
  sessionKey?: string;
  sessionStore?: Record<string, SessionEntry>;
  turnModelOverride?: string;
}): HarnessSourceVisibleRepliesDefault | undefined {
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return undefined;
  }
  try {
    const defaultModelRef = resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.sessionAgentId,
    });
    const aliasIndex = buildModelAliasIndex({
      cfg: params.cfg,
      defaultProvider: defaultModelRef.provider,
    });
    const parentSessionKey = resolveHarnessDefaultParentSessionKey(params);
    const channelModelCandidate = resolveChannelModelCandidate({
      aliasIndex,
      cfg: params.cfg,
      ctx: params.ctx,
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
    });
    const storedModelCandidate = resolveStoredModelCandidate({
      cfg: params.cfg,
      defaultProvider: defaultModelRef.provider,
      entry: params.entry,
      parentSessionKey,
      sessionAgentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
    });
    const turnModelCandidate = resolveModelOverrideCandidate({
      aliasIndex,
      defaultProvider: defaultModelRef.provider,
      modelOverride: params.turnModelOverride,
    });
    const resolveCandidateDefault = (candidate: { provider: string; model?: string }) => {
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
      return harness.deliveryDefaults?.sourceVisibleReplies;
    };
    const selectedModelCandidate =
      turnModelCandidate ?? storedModelCandidate ?? channelModelCandidate;
    if (selectedModelCandidate) {
      return resolveCandidateDefault(selectedModelCandidate);
    }
    const sourceProvider = normalizeOptionalString(
      params.entry?.origin?.provider ?? params.ctx.Provider ?? params.ctx.Surface,
    );
    if (sourceProvider) {
      const sourceDefault = resolveCandidateDefault({ provider: sourceProvider });
      if (sourceDefault) {
        return sourceDefault;
      }
    }
    return resolveCandidateDefault(defaultModelRef);
  } catch (error) {
    logVerbose(
      `dispatch-from-config: could not resolve harness visible-reply defaults: ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}
