/** Gateway-backed ACP session snapshots, controls, metadata, and usage updates. */
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { toAcpSessionLineageMeta } from "@openclaw/acp-core/session-lineage-meta";
import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow, SessionsListResult } from "../gateway/session-utils.js";
import {
  ACP_ELEVATED_LEVEL_CONFIG_ID,
  ACP_FAST_MODE_CONFIG_ID,
  ACP_REASONING_LEVEL_CONFIG_ID,
  ACP_RESPONSE_USAGE_CONFIG_ID,
  ACP_THOUGHT_LEVEL_CONFIG_ID,
  ACP_TIMEOUT_CONFIG_ID,
  ACP_TIMEOUT_SECONDS_CONFIG_ID,
  ACP_TRACE_LEVEL_CONFIG_ID,
  ACP_VERBOSE_LEVEL_CONFIG_ID,
  buildSessionMetadata,
  buildSessionPresentation,
  buildSessionUsageSnapshot,
  type GatewaySessionPresentationRow,
  type SessionSnapshot,
} from "./translator.presentation.js";
import type { AcpTranslatorSessionUpdates } from "./translator.session-updates.js";

export class AcpTranslatorSessionState {
  constructor(
    private readonly gateway: GatewayClient,
    private readonly sessionUpdates: AcpTranslatorSessionUpdates,
    private readonly log: (msg: string) => void,
  ) {}

  async getSnapshot(
    sessionKey: string,
    overrides?: Partial<GatewaySessionPresentationRow>,
  ): Promise<SessionSnapshot> {
    try {
      const row = await this.getGatewaySessionRow(sessionKey);
      return {
        ...buildSessionPresentation({ row, overrides }),
        metadata: buildSessionMetadata({ row, sessionKey }),
        usage: buildSessionUsageSnapshot(row),
      };
    } catch (err) {
      this.log(`session presentation fallback for ${sessionKey}: ${String(err)}`);
      return {
        ...buildSessionPresentation({ overrides }),
        metadata: buildSessionMetadata({ sessionKey }),
      };
    }
  }

  async getExistingSnapshot(sessionKey: string): Promise<SessionSnapshot> {
    const row = await this.getGatewaySessionRow(sessionKey);
    if (!row) {
      throw new Error(`Session ${sessionKey} not found`);
    }
    return {
      ...buildSessionPresentation({ row }),
      metadata: buildSessionMetadata({ row, sessionKey }),
      usage: buildSessionUsageSnapshot(row),
    };
  }

  mapGatewaySession(session: GatewaySessionRow, fallbackCwd: string): SessionInfo {
    const cwd =
      normalizeOptionalString(session.spawnedCwd) ??
      normalizeOptionalString(session.spawnedWorkspaceDir) ??
      fallbackCwd;
    return {
      sessionId: session.key,
      cwd,
      title: session.derivedTitle ?? session.displayName ?? session.label ?? session.key,
      updatedAt: timestampMsToIsoString(session.updatedAt),
      _meta: toAcpSessionLineageMeta(session),
    };
  }

  async sendSnapshotUpdate(
    session: { sessionId: string; sessionKey: string; ledgerSessionId?: string },
    sessionSnapshot: SessionSnapshot,
    options: {
      includeControls: boolean;
      record: boolean;
      runId?: string;
      deferDelivery?: boolean;
      deliveryGuard?: () => boolean;
    },
  ): Promise<void> {
    const deliveryOptions = {
      ...(options.deferDelivery ? { deferDelivery: true } : {}),
      ...(options.deliveryGuard ? { deliveryGuard: options.deliveryGuard } : {}),
    };
    if (options.includeControls) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        ...deliveryOptions,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: sessionSnapshot.modes.currentModeId,
        },
      });
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        ...deliveryOptions,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: sessionSnapshot.configOptions,
        },
      });
    }
    if (sessionSnapshot.metadata) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        ...deliveryOptions,
        update: {
          sessionUpdate: "session_info_update",
          ...sessionSnapshot.metadata,
        },
      });
    }
    if (sessionSnapshot.usage) {
      await this.sessionUpdates.emit({
        sessionId: session.sessionId,
        sessionKey: session.sessionKey,
        ...(session.ledgerSessionId ? { ledgerSessionId: session.ledgerSessionId } : {}),
        runId: options.runId,
        record: options.record,
        ...deliveryOptions,
        update: {
          sessionUpdate: "usage_update",
          used: sessionSnapshot.usage.used,
          size: sessionSnapshot.usage.size,
          _meta: {
            source: "gateway-session-store",
            approximate: true,
          },
        },
      });
    }
  }

  resolveConfigPatch(
    configId: string,
    value: string | boolean,
  ): {
    overrides: Partial<GatewaySessionPresentationRow>;
    patch?: Record<string, string | boolean | null>;
  } {
    if (typeof value !== "string") {
      throw new Error(
        `ACP bridge does not support non-string session config option values for "${configId}".`,
      );
    }
    switch (configId) {
      case ACP_THOUGHT_LEVEL_CONFIG_ID:
        return {
          patch: { thinkingLevel: value },
          overrides: { thinkingLevel: value },
        };
      case ACP_FAST_MODE_CONFIG_ID: {
        const fastMode = normalizeFastMode(value);
        if (fastMode === undefined) {
          throw new Error(`Unsupported fast mode value: ${value}`);
        }
        return {
          patch: { fastMode },
          overrides: { fastMode },
        };
      }
      case ACP_VERBOSE_LEVEL_CONFIG_ID:
        return {
          patch: { verboseLevel: value },
          overrides: { verboseLevel: value },
        };
      case ACP_TRACE_LEVEL_CONFIG_ID:
        return {
          patch: { traceLevel: value },
          overrides: { traceLevel: value },
        };
      case ACP_REASONING_LEVEL_CONFIG_ID:
        return {
          patch: { reasoningLevel: value },
          overrides: { reasoningLevel: value },
        };
      case ACP_RESPONSE_USAGE_CONFIG_ID: {
        const next = value === "inherit" ? null : value;
        return {
          patch: { responseUsage: next },
          overrides: { responseUsage: next as GatewaySessionPresentationRow["responseUsage"] },
        };
      }
      case ACP_ELEVATED_LEVEL_CONFIG_ID:
        return {
          patch: { elevatedLevel: value },
          overrides: { elevatedLevel: value },
        };
      case ACP_TIMEOUT_CONFIG_ID:
      case ACP_TIMEOUT_SECONDS_CONFIG_ID:
        return {
          overrides: {},
        };
      default:
        throw new Error(`ACP bridge mode does not support session config option "${configId}".`);
    }
  }

  private async getGatewaySessionRow(
    sessionKey: string,
  ): Promise<GatewaySessionPresentationRow | undefined> {
    const result = await this.gateway.request<SessionsListResult>("sessions.list", {
      limit: 200,
      search: sessionKey,
      includeDerivedTitles: true,
    });
    const session = result.sessions.find((entry) => entry.key === sessionKey);
    if (!session) {
      return undefined;
    }
    return {
      key: session.key,
      kind: session.kind,
      channel: session.channel,
      parentSessionKey: session.parentSessionKey,
      spawnedBy: session.spawnedBy,
      spawnDepth: session.spawnDepth,
      subagentRole: session.subagentRole,
      subagentControlScope: session.subagentControlScope,
      spawnedWorkspaceDir: session.spawnedWorkspaceDir,
      spawnedCwd: session.spawnedCwd,
      displayName: session.displayName,
      label: session.label,
      derivedTitle: session.derivedTitle,
      updatedAt: session.updatedAt,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.thinkingLevels,
      modelProvider: session.modelProvider,
      model: session.model,
      fastMode: session.fastMode,
      effectiveFastMode: session.effectiveFastMode,
      verboseLevel: session.verboseLevel,
      traceLevel: session.traceLevel,
      reasoningLevel: session.reasoningLevel,
      responseUsage: session.responseUsage,
      elevatedLevel: session.elevatedLevel,
      totalTokens: session.totalTokens,
      totalTokensFresh: session.totalTokensFresh,
      contextTokens: session.contextTokens,
    };
  }
}
