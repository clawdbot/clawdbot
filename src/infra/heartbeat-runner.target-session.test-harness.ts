import { heartbeatRunnerWhatsAppPlugin } from "../../test/helpers/infra/heartbeat-runner-channel-plugins.js";
import { jsonResult } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  type HeartbeatReplySpy,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

export const TARGET_SESSION_RECIPIENT = "+15551234567";
export const STALE_TARGET_SESSION_RECIPIENT = "stale-target";

export type TargetSessionDeliveryRequest = {
  onPayload?: (payload: { text: string; mediaUrls: string[] }) => void;
  onDeliveredPayload?: (payload: { text: string; mediaUrls: string[] }) => void;
  payloads?: Array<{ text?: string; mediaUrl?: string; mediaUrls?: string[] }>;
};

export type TargetSessionScenarioContext = {
  cfg: OpenClawConfig;
  storePath: string;
  replySpy: HeartbeatReplySpy;
  baseSessionKey: string;
  isolatedSessionKey: string;
  targetSessionKey: string;
  targetSessionId?: string;
  nowMs: number;
};

export type TargetSessionTargetSeed = {
  sessionId: string;
  lifecycleRevision?: string;
  lastTo?: string;
};

export function completeTargetSessionDelivery(
  request: TargetSessionDeliveryRequest,
  messageId: string,
) {
  for (const payload of request.payloads ?? []) {
    const normalized = {
      text: payload.text ?? "",
      mediaUrls: [payload.mediaUrl, ...(payload.mediaUrls ?? [])].filter((value): value is string =>
        Boolean(value),
      ),
    };
    request.onPayload?.(normalized);
    request.onDeliveredPayload?.(normalized);
  }
  return [{ channel: "whatsapp", messageId }];
}

export function installRoutedWhatsAppPlugin(
  targetSessionKey: string,
  pluginActionPayload?: Record<string, unknown>,
  omitProjectionSessionOwner = false,
): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: {
          ...heartbeatRunnerWhatsAppPlugin,
          ...(pluginActionPayload
            ? {
                actions: {
                  describeMessageTool: () => ({ actions: ["send" as const] }),
                  handleAction: async () => jsonResult(pluginActionPayload),
                },
              }
            : {}),
          messaging: {
            ...heartbeatRunnerWhatsAppPlugin.messaging,
            ...(omitProjectionSessionOwner
              ? {
                  resolveConversationRouteOwner: () => ({
                    kind: "agent" as const,
                    agentId: "main",
                  }),
                }
              : {}),
            resolveOutboundSessionRoute: ({ target }: { target: string }) => ({
              sessionKey: targetSessionKey,
              baseSessionKey: targetSessionKey,
              recipientSessionExact: true,
              peer: { kind: "direct", id: target },
              chatType: "direct",
              from: `whatsapp:${target}`,
              to: target,
            }),
          },
        },
      },
    ]),
  );
}

async function seedRouteSession(
  storePath: string,
  sessionKey: string,
  nowMs: number,
  seed: TargetSessionTargetSeed,
): Promise<void> {
  await seedSessionStore(storePath, sessionKey, {
    sessionId: seed.sessionId,
    lifecycleRevision: seed.lifecycleRevision,
    updatedAt: nowMs - 1_000,
    lastChannel: "whatsapp",
    lastProvider: "whatsapp",
    lastTo: seed.lastTo ?? TARGET_SESSION_RECIPIENT,
  });
}

export async function withRoutedTargetSessionScenario<T>(
  options: {
    targetSessionKey: string;
    target?: TargetSessionTargetSeed;
    replyText?: string;
  },
  test: (context: TargetSessionScenarioContext) => Promise<T>,
): Promise<T> {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "last", isolatedSession: true },
        },
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath, dmScope: "per-channel-peer" },
    };
    const baseSessionKey = resolveMainSessionKey(cfg);
    const nowMs = Date.now();
    installRoutedWhatsAppPlugin(options.targetSessionKey);
    await seedRouteSession(storePath, baseSessionKey, nowMs, { sessionId: "base-session" });
    if (options.target) {
      await seedRouteSession(storePath, options.targetSessionKey, nowMs, options.target);
    }
    if (options.replyText !== undefined) {
      replySpy.mockResolvedValueOnce({ text: options.replyText });
    }
    return await test({
      cfg,
      storePath,
      replySpy,
      baseSessionKey,
      isolatedSessionKey: `${baseSessionKey}:heartbeat`,
      targetSessionKey: options.targetSessionKey,
      targetSessionId: options.target?.sessionId,
      nowMs,
    });
  });
}

export function runTargetSessionScenario(
  context: TargetSessionScenarioContext,
  sessionKey?: string,
  readCurrentConfig?: () => OpenClawConfig,
) {
  return runHeartbeatOnce({
    cfg: context.cfg,
    ...(readCurrentConfig ? { readCurrentConfig } : {}),
    sessionKey,
    deps: {
      getReplyFromConfig: context.replySpy,
      getQueueSize: () => 0,
      nowMs: () => context.nowMs,
    },
  });
}

export async function readTargetSessionTranscript(
  context: TargetSessionScenarioContext,
  sessionId = context.targetSessionId ?? "target-session",
): Promise<string> {
  return JSON.stringify(
    await loadTranscriptEvents({
      agentId: "main",
      sessionKey: context.targetSessionKey,
      sessionId,
      storePath: context.storePath,
    }),
  );
}
