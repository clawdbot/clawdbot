import { randomUUID } from "node:crypto";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateNodeInvokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isAdminOnlyNodeInvokeCommand } from "../../infra/node-commands.js";
import { captureNodePairingGeneration } from "../../infra/node-pairing-state.js";
import { isForbiddenBrowserProxyMutation } from "../node-browser-proxy-policy.js";
import {
  isForegroundRestrictedPluginNodeCommand,
  isNodeCommandAllowed,
  resolveNodeCommandAllowlist,
} from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { sanitizeNodeInvokeParamsForForwarding } from "../node-invoke-sanitize.js";
import { enqueuePendingNodeAction, removePendingNodeAction } from "../node-runtime-state.js";
import {
  captureNodeWakeLifecycle,
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  releaseNodeWakeLifecycle,
} from "../node-wake-state.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { buildNodeCommandRejectionHint } from "./node-command-rejection-hint.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { handleNodeInvokeProgress } from "./nodes.handlers.invoke-progress.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import {
  respondInvalidParams,
  respondUnavailableOnNodeInvokeError,
  respondUnavailableOnThrow,
  safeParseJson,
} from "./nodes.helpers.js";
import { toPendingParamsJSON } from "./nodes.pending.js";
import {
  isNodePairingWorkCurrent,
  resolveDispatchableNodeSession,
  respondPairingChanged,
} from "./nodes.shared.js";
import {
  maybeSendNodeWakeNudge,
  maybeWakeNodeWithApns,
  waitForNodeReconnect,
} from "./nodes.wake.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

const TALK_PTT_COMMANDS = new Set([
  "talk.ptt.start",
  "talk.ptt.stop",
  "talk.ptt.cancel",
  "talk.ptt.once",
]);
const talkPttEventSeqBySessionId = new Map<string, number>();

function isForegroundRestrictedIosCommand(command: string): boolean {
  return (
    isForegroundRestrictedPluginNodeCommand(command) ||
    command.startsWith("camera.") ||
    command.startsWith("screen.") ||
    command.startsWith("talk.")
  );
}

function shouldQueueAsPendingForegroundAction(params: {
  platform?: string;
  command: string;
  error: unknown;
}): boolean {
  // iOS cannot run camera/screen/Talk commands in the background. Queue only
  // those foreground-only commands when the node explicitly reports that state.
  const platform = normalizeLowercaseStringOrEmpty(params.platform);
  if (!platform.startsWith("ios") && !platform.startsWith("ipados")) {
    return false;
  }
  if (!isForegroundRestrictedIosCommand(params.command)) {
    return false;
  }
  const error =
    params.error && typeof params.error === "object"
      ? (params.error as { code?: unknown; message?: unknown })
      : null;
  const code = normalizeOptionalString(error?.code)?.toUpperCase() ?? "";
  const message = normalizeOptionalString(error?.message)?.toUpperCase() ?? "";
  return code === "NODE_BACKGROUND_UNAVAILABLE" || message.includes("BACKGROUND_UNAVAILABLE");
}

function emitTalkPttNodeEvent(params: {
  context: Pick<GatewayRequestContext, "broadcast">;
  nodeId: string;
  command: string;
  payload: unknown;
}): void {
  if (!TALK_PTT_COMMANDS.has(params.command)) {
    return;
  }
  const payloadObj =
    typeof params.payload === "object" && params.payload !== null
      ? (params.payload as Record<string, unknown>)
      : {};
  const captureId = normalizeOptionalString(payloadObj.captureId) ?? randomUUID();
  const sessionId = `node:${params.nodeId}:talk:${captureId}`;
  const seq = (talkPttEventSeqBySessionId.get(sessionId) ?? 0) + 1;
  talkPttEventSeqBySessionId.set(sessionId, seq);
  while (talkPttEventSeqBySessionId.size > 2048) {
    const oldest = talkPttEventSeqBySessionId.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    talkPttEventSeqBySessionId.delete(oldest);
  }

  const type =
    params.command === "talk.ptt.start"
      ? "capture.started"
      : params.command === "talk.ptt.cancel"
        ? "capture.cancelled"
        : params.command === "talk.ptt.once"
          ? "capture.once"
          : "capture.stopped";
  const final = params.command !== "talk.ptt.start";
  const talkEvent = {
    id: `${sessionId}:${seq}`,
    type,
    sessionId,
    captureId,
    seq,
    timestamp: new Date().toISOString(),
    mode: "stt-tts",
    transport: "managed-room",
    brain: "agent-consult",
    final,
    payload: {
      nodeId: params.nodeId,
      command: params.command,
      status: normalizeOptionalString(payloadObj.status) ?? undefined,
      transcript: normalizeOptionalString(payloadObj.transcript) ?? undefined,
    },
  };
  params.context.broadcast(
    "talk.event",
    {
      nodeId: params.nodeId,
      command: params.command,
      talkEvent,
    },
    { dropIfSlow: true },
  );
}

export const nodeInvokeHandlers: GatewayRequestHandlers = {
  "node.invoke": async ({ params, respond, context, client, req }) => {
    if (!validateNodeInvokeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.invoke",
        validator: validateNodeInvokeParams,
      });
      return;
    }
    const p = params as {
      nodeId: string;
      command: string;
      params?: unknown;
      timeoutMs?: number;
      idempotencyKey: string;
      sessionKey?: string;
      turnSourceChannel?: string;
      turnSourceTo?: string;
      turnSourceAccountId?: string;
      turnSourceThreadId?: string | number;
    };
    const nodeId = normalizeOptionalString(p.nodeId) ?? "";
    const command = normalizeOptionalString(p.command) ?? "";
    const sessionKey = normalizeOptionalString(p.sessionKey);
    if (!nodeId || !command) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "nodeId and command required"),
      );
      return;
    }
    if (command === "system.execApprovals.get" || command === "system.execApprovals.set") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke does not allow system.execApprovals.*; use exec.approvals.node.*",
          { details: { command } },
        ),
      );
      return;
    }
    if (nodeInvokePolicy.rejectClaudeAgentRun(command, respond)) {
      return;
    }
    if (command === "browser.proxy" && isForbiddenBrowserProxyMutation(p.params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.invoke cannot mutate persistent browser profiles via browser.proxy",
          { details: { command } },
        ),
      );
      return;
    }
    if (
      isAdminOnlyNodeInvokeCommand(command) &&
      !nodeInvokePolicy.clientHasOperatorAdminScope(client)
    ) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(nodeId);
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
      try {
        const continuePairingWork = async (): Promise<boolean> => {
          if (await isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle })) {
            return true;
          }
          respondPairingChanged(respond);
          return false;
        };

        const cfg = context.getRuntimeConfig();
        let nodeSession = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
        );
        if (!nodeSession) {
          const wakeReqId = req.id;
          const wakeFlowStartedAtMs = Date.now();
          context.logGateway.info(
            `node wake start node=${nodeId} req=${wakeReqId} command=${command}`,
          );

          const wake = await maybeWakeNodeWithApns(nodeId, {
            cfg,
            lifecycle: wakeLifecycle,
            generation,
          });
          context.logGateway.info(
            `node wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
              `available=${wake.available} throttled=${wake.throttled} ` +
              `path=${wake.path} durationMs=${wake.durationMs} ` +
              `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
          );
          if (wake.available) {
            const waitStartedAtMs = Date.now();
            const waitTimeoutMs = NODE_WAKE_RECONNECT_WAIT_MS;
            const reconnected = await waitForNodeReconnect({
              nodeId,
              context,
              timeoutMs: waitTimeoutMs,
              lifecycle: wakeLifecycle,
              pairingGeneration: generation.key,
            });
            const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
            context.logGateway.info(
              `node wake stage=wait1 node=${nodeId} req=${wakeReqId} ` +
                `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
            );
          }
          if (!(await continuePairingWork())) {
            return;
          }
          nodeSession = resolveDispatchableNodeSession(
            context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
          );
          if (!nodeSession && wake.available) {
            const retryWake = await maybeWakeNodeWithApns(nodeId, {
              force: true,
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            context.logGateway.info(
              `node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
                `available=${retryWake.available} throttled=${retryWake.throttled} ` +
                `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
                `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
            );
            if (retryWake.available) {
              const waitStartedAtMs = Date.now();
              const waitTimeoutMs = NODE_WAKE_RECONNECT_RETRY_WAIT_MS;
              const reconnected = await waitForNodeReconnect({
                nodeId,
                context,
                timeoutMs: waitTimeoutMs,
                lifecycle: wakeLifecycle,
                pairingGeneration: generation.key,
              });
              const waitDurationMs = Math.max(0, Date.now() - waitStartedAtMs);
              context.logGateway.info(
                `node wake stage=wait2 node=${nodeId} req=${wakeReqId} ` +
                  `reconnected=${reconnected} timeoutMs=${waitTimeoutMs} durationMs=${waitDurationMs}`,
              );
            }
            if (!(await continuePairingWork())) {
              return;
            }
            nodeSession = resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
            );
          }
          if (!nodeSession) {
            const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
            const nudge = await maybeSendNodeWakeNudge(nodeId, {
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            if (!(await continuePairingWork())) {
              return;
            }
            context.logGateway.info(
              `node wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
                `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
                `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
            );
            context.logGateway.warn(
              `node wake done node=${nodeId} req=${wakeReqId} connected=false ` +
                `reason=not_connected totalMs=${totalDurationMs}`,
            );
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "node not connected", {
                details: { code: "NOT_CONNECTED" },
              }),
            );
            return;
          }

          const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
          context.logGateway.info(
            `node wake done node=${nodeId} req=${wakeReqId} connected=true totalMs=${totalDurationMs}`,
          );
        }
        // A reload may revoke authority for an in-flight request, but it must not
        // retroactively grant one that was denied when admitted before node wake.
        for (const authorizationCfg of [cfg, context.getRuntimeConfig()]) {
          const allowlist = resolveNodeCommandAllowlist(authorizationCfg, {
            ...nodeSession,
            approvedCommands: nodeSession.commands,
          });
          const allowed = isNodeCommandAllowed({
            command,
            declaredCommands: nodeSession.commands,
            allowlist,
          });
          if (!allowed.ok) {
            const hint = buildNodeCommandRejectionHint(
              allowed.reason,
              command,
              nodeSession,
              authorizationCfg,
            );
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, hint, {
                details: { reason: allowed.reason, command },
              }),
            );
            return;
          }
        }

        const forwardedParams = sanitizeNodeInvokeParamsForForwarding({
          nodeId,
          command,
          rawParams: p.params,
          client,
          execApprovalManager: context.execApprovalManager,
        });
        if (!forwardedParams.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, forwardedParams.message, {
              details: forwardedParams.details ?? null,
            }),
          );
          return;
        }
        const policyResult = await applyPluginNodeInvokePolicy({
          context,
          client,
          nodeSession,
          command,
          params: forwardedParams.params,
          turnSource: {
            channel: p.turnSourceChannel,
            to: p.turnSourceTo,
            accountId: p.turnSourceAccountId,
            threadId: p.turnSourceThreadId,
          },
          timeoutMs: p.timeoutMs,
          idempotencyKey: p.idempotencyKey,
          isInvocationCurrent: () =>
            isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }),
        });
        if (!(await continuePairingWork())) {
          return;
        }
        if (policyResult) {
          // Plugin policies can satisfy an invocation without crossing the raw
          // node command channel; still emit mirrored Talk events for UI state.
          if (!policyResult.ok) {
            const errorCode = policyResult.unavailable
              ? ErrorCodes.UNAVAILABLE
              : ErrorCodes.INVALID_REQUEST;
            respond(
              false,
              undefined,
              errorShape(errorCode, policyResult.message, {
                details: {
                  ...policyResult.details,
                  ...(policyResult.code ? { code: policyResult.code } : {}),
                },
              }),
            );
            return;
          }
          const payload = policyResult.payloadJSON
            ? safeParseJson(policyResult.payloadJSON)
            : policyResult.payload;
          emitTalkPttNodeEvent({
            context,
            nodeId,
            command,
            payload,
          });
          respond(
            true,
            {
              ok: true,
              nodeId,
              command,
              payload: policyResult.payload,
              payloadJSON: policyResult.payloadJSON ?? null,
            },
            undefined,
          );
          return;
        }
        const dispatchSession = resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
        );
        if (!dispatchSession || dispatchSession.connId !== nodeSession.connId) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node connection changed before dispatch", {
              retryable: true,
              details: { code: "ROUTE_CHANGED" },
            }),
          );
          return;
        }
        const dispatchCfg = context.getRuntimeConfig();
        const dispatchAllowlist = resolveNodeCommandAllowlist(dispatchCfg, {
          ...dispatchSession,
          approvedCommands: dispatchSession.commands,
        });
        const dispatchAllowed = isNodeCommandAllowed({
          command,
          declaredCommands: dispatchSession.commands,
          allowlist: dispatchAllowlist,
        });
        if (!dispatchAllowed.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              buildNodeCommandRejectionHint(
                dispatchAllowed.reason,
                command,
                dispatchSession,
                dispatchCfg,
              ),
              { details: { reason: dispatchAllowed.reason, command } },
            ),
          );
          return;
        }
        const res = await context.nodeRegistry.invoke({
          nodeId,
          expectedConnId: nodeSession.connId,
          expectedPairingGeneration: generation.key,
          command,
          params: forwardedParams.params,
          timeoutMs: p.timeoutMs,
          idempotencyKey: p.idempotencyKey,
          ...(sessionKey ? { sessionKey } : {}),
        });
        if (!(await continuePairingWork())) {
          return;
        }
        if (!res.ok) {
          if (
            shouldQueueAsPendingForegroundAction({
              platform: nodeSession.platform,
              command,
              error: res.error,
            })
          ) {
            // Foreground-only iOS commands become pullable pending actions instead
            // of failing permanently while the device is locked/backgrounded.
            const paramsJSON = toPendingParamsJSON(forwardedParams.params);
            const queued = enqueuePendingNodeAction({
              nodeId,
              pairingGeneration: generation.key,
              command,
              paramsJSON,
              idempotencyKey: p.idempotencyKey,
              ttlMs: nodeInvokePolicy.pendingActionTtlMs,
              maxPerNode: nodeInvokePolicy.pendingActionMaxPerNode,
            });
            const wake = await maybeWakeNodeWithApns(nodeId, {
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            if (!(await continuePairingWork())) {
              if (queued.created) {
                removePendingNodeAction({
                  nodeId,
                  pairingGeneration: generation.key,
                  actionId: queued.action.id,
                  ttlMs: nodeInvokePolicy.pendingActionTtlMs,
                });
              }
              return;
            }
            context.logGateway.info(
              `node pending queued node=${nodeId} req=${req.id} command=${command} ` +
                `queuedId=${queued.action.id} wakePath=${wake.path} wakeAvailable=${wake.available}`,
            );
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                "node command queued until iOS returns to foreground",
                {
                  retryable: true,
                  details: {
                    code: "QUEUED_UNTIL_FOREGROUND",
                    queuedActionId: queued.action.id,
                    nodeId,
                    command,
                    wake: {
                      path: wake.path,
                      available: wake.available,
                      throttled: wake.throttled,
                      apnsStatus: wake.apnsStatus,
                      apnsReason: wake.apnsReason,
                    },
                    nodeError: res.error ?? null,
                  },
                },
              ),
            );
            return;
          }
          if (!respondUnavailableOnNodeInvokeError(respond, res)) {
            return;
          }
          return;
        }
        const payload = res.payloadJSON ? safeParseJson(res.payloadJSON) : res.payload;
        emitTalkPttNodeEvent({
          context,
          nodeId,
          command,
          payload,
        });
        respond(
          true,
          {
            ok: true,
            nodeId,
            command,
            payload,
            payloadJSON: res.payloadJSON ?? null,
          },
          undefined,
        );
      } finally {
        releaseNodeWakeLifecycle(nodeId, wakeLifecycle);
      }
    });
  },
  "node.invoke.progress": handleNodeInvokeProgress,
  "node.invoke.result": handleNodeInvokeResult,
};
