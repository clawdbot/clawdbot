import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateNodeInvokeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { captureNodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import {
  isAdminOnlyNodeInvokeCommand,
  isBrowserProxyNodeInvokeCommand,
  isPrivateNodeInvokeCommand,
} from "../../infra/node-commands.js";
import { isForbiddenBrowserProxyMutation } from "../node-browser-proxy-policy.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
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
  respondUnavailableOnNodeInvokeErrorWithProvenance,
  respondUnavailableOnThrow,
  parseGatewayPayload,
} from "./nodes.helpers.js";
import {
  isForwardedNodeInvokeApprovalAuthorityActive,
  resolveNodeInvokeRuntimeAuthorityError,
} from "./nodes.invoke-authority.js";
import {
  awaitNodeInvokeWithinDeadline,
  NODE_INVOKE_DEADLINE_EXPIRED,
} from "./nodes.invoke-deadline.js";
import { shouldQueueAsPendingForegroundAction } from "./nodes.invoke-foreground.js";
import { emitTalkPttNodeEvent } from "./nodes.invoke-talk-events.js";
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
import type { GatewayRequestHandlers } from "./types.js";

export const nodeInvokeHandlers: GatewayRequestHandlers = {
  "node.invoke": async ({ params, respond, context, client, req, signal }) => {
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
    if (isPrivateNodeInvokeCommand(command)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "node.invoke does not allow private node controls", {
          details: { command },
        }),
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
    if (isBrowserProxyNodeInvokeCommand(command) && isForbiddenBrowserProxyMutation(p.params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `node.invoke cannot mutate persistent browser profiles via ${command}`,
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
    const invokeDeadlineAtMs =
      typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? Date.now() + p.timeoutMs : undefined;
    let nodeCommandDispatched = false;
    const resolveRemainingInvokeTimeoutMs = () =>
      invokeDeadlineAtMs === undefined ? p.timeoutMs : Math.max(0, invokeDeadlineAtMs - Date.now());
    const respondIfInvokeExpired = () => {
      if (invokeDeadlineAtMs === undefined || resolveRemainingInvokeTimeoutMs() !== 0) {
        return false;
      }
      respondUnavailableOnNodeInvokeErrorWithProvenance(
        respond,
        {
          ok: false,
          error: { code: "TIMEOUT", message: "node invoke timed out" },
        },
        { nodeCommandDispatched },
      );
      return true;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await awaitNodeInvokeWithinDeadline(
        () => captureNodePairingGeneration(nodeId),
        invokeDeadlineAtMs,
      );
      if (generation === NODE_INVOKE_DEADLINE_EXPIRED) {
        respondIfInvokeExpired();
        return;
      }
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
      // Wake helpers identify their owner by the original signal. Compose the
      // caller only for dispatched node work; never replace that owner signal.
      const invocationLifecycle = signal ? AbortSignal.any([wakeLifecycle, signal]) : wakeLifecycle;
      let releaseApprovalHandoff: (() => void) | undefined;
      try {
        const continuePairingWork = async (): Promise<boolean> => {
          const pairingCurrent = await awaitNodeInvokeWithinDeadline(
            () => isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }),
            invokeDeadlineAtMs,
          );
          if (pairingCurrent === NODE_INVOKE_DEADLINE_EXPIRED) {
            respondIfInvokeExpired();
            return false;
          }
          if (pairingCurrent) {
            return true;
          }
          respondPairingChanged(respond);
          return false;
        };

        if (respondIfInvokeExpired()) {
          return;
        }

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

          // Wake attempts can be shared; expire this caller without aborting a
          // push that another live invocation still owns.
          const wake = await awaitNodeInvokeWithinDeadline(
            () =>
              maybeWakeNodeWithApns(nodeId, {
                cfg,
                lifecycle: wakeLifecycle,
                generation,
              }),
            invokeDeadlineAtMs,
          );
          if (wake === NODE_INVOKE_DEADLINE_EXPIRED) {
            respondIfInvokeExpired();
            return;
          }
          context.logGateway.info(
            `node wake stage=wake1 node=${nodeId} req=${wakeReqId} ` +
              `available=${wake.available} throttled=${wake.throttled} ` +
              `path=${wake.path} durationMs=${wake.durationMs} ` +
              `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
          );
          if (respondIfInvokeExpired()) {
            return;
          }
          if (wake.available) {
            const waitStartedAtMs = Date.now();
            const remainingTimeoutMs = resolveRemainingInvokeTimeoutMs();
            const waitTimeoutMs =
              invokeDeadlineAtMs === undefined
                ? NODE_WAKE_RECONNECT_WAIT_MS
                : Math.min(NODE_WAKE_RECONNECT_WAIT_MS, remainingTimeoutMs ?? 0);
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
          if (!(await continuePairingWork()) || respondIfInvokeExpired()) {
            return;
          }
          nodeSession = resolveDispatchableNodeSession(
            context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
          );
          if (!nodeSession && wake.available) {
            const retryWake = await awaitNodeInvokeWithinDeadline(
              () =>
                maybeWakeNodeWithApns(nodeId, {
                  force: true,
                  cfg,
                  lifecycle: wakeLifecycle,
                  generation,
                }),
              invokeDeadlineAtMs,
            );
            if (retryWake === NODE_INVOKE_DEADLINE_EXPIRED) {
              respondIfInvokeExpired();
              return;
            }
            context.logGateway.info(
              `node wake stage=wake2 node=${nodeId} req=${wakeReqId} force=true ` +
                `available=${retryWake.available} throttled=${retryWake.throttled} ` +
                `path=${retryWake.path} durationMs=${retryWake.durationMs} ` +
                `apnsStatus=${retryWake.apnsStatus ?? -1} apnsReason=${retryWake.apnsReason ?? "-"}`,
            );
            if (respondIfInvokeExpired()) {
              return;
            }
            if (retryWake.available) {
              const waitStartedAtMs = Date.now();
              const remainingTimeoutMs = resolveRemainingInvokeTimeoutMs();
              const waitTimeoutMs =
                invokeDeadlineAtMs === undefined
                  ? NODE_WAKE_RECONNECT_RETRY_WAIT_MS
                  : Math.min(NODE_WAKE_RECONNECT_RETRY_WAIT_MS, remainingTimeoutMs ?? 0);
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
            if (!(await continuePairingWork()) || respondIfInvokeExpired()) {
              return;
            }
            nodeSession = resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, generation.key),
            );
          }
          if (!nodeSession) {
            if (respondIfInvokeExpired()) {
              return;
            }
            const totalDurationMs = Math.max(0, Date.now() - wakeFlowStartedAtMs);
            const nudge = await awaitNodeInvokeWithinDeadline(
              () =>
                maybeSendNodeWakeNudge(nodeId, {
                  cfg,
                  lifecycle: wakeLifecycle,
                  generation,
                }),
              invokeDeadlineAtMs,
            );
            if (nudge === NODE_INVOKE_DEADLINE_EXPIRED) {
              respondIfInvokeExpired();
              return;
            }
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
                details: {
                  code: "NOT_CONNECTED",
                  nodeError: { code: "NOT_CONNECTED", message: "node not connected" },
                  nodeCommandDispatched: false,
                },
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
        if (respondIfInvokeExpired()) {
          return;
        }
        if (forwardedParams.approvalAuthority) {
          const authority = forwardedParams.approvalAuthority;
          releaseApprovalHandoff =
            context.execApprovalManager?.retainForHandoff(authority.recordId) ?? undefined;
          if (!releaseApprovalHandoff) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "approved runtime authority closed before node dispatch",
                { details: { code: "APPROVAL_AUTHORITY_CLOSED" } },
              ),
            );
            return;
          }
        }
        const isForwardedApprovalAuthorityActive = () =>
          isForwardedNodeInvokeApprovalAuthorityActive({
            manager: context.execApprovalManager,
            authority: forwardedParams.approvalAuthority,
          });
        const policyResult = await awaitNodeInvokeWithinDeadline(
          () =>
            applyPluginNodeInvokePolicy({
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
              signal: invocationLifecycle,
              resolveRemainingTimeoutMs: resolveRemainingInvokeTimeoutMs,
              onNodeCommandDispatched: () => {
                // Deadline races must retain transport ownership so a command
                // already handed to the node is never advertised as retry-safe.
                nodeCommandDispatched = true;
              },
              idempotencyKey: p.idempotencyKey,
              isInvocationCurrent: () =>
                isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }),
              isApprovalAuthorityActive: isForwardedApprovalAuthorityActive,
            }),
          invokeDeadlineAtMs,
        );
        if (policyResult === NODE_INVOKE_DEADLINE_EXPIRED) {
          respondIfInvokeExpired();
          return;
        }
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
            ? parseGatewayPayload(policyResult.payloadJSON)
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
        const dispatchTimeoutMs = resolveRemainingInvokeTimeoutMs();
        if (invokeDeadlineAtMs !== undefined && dispatchTimeoutMs === 0) {
          respondIfInvokeExpired();
          return;
        }
        // Policy, pairing, and approval checks above may await. Revalidate the
        // exact runtime capability at the final raw transport handoff.
        const authorityError = resolveNodeInvokeRuntimeAuthorityError({
          context,
          client,
          approvalAuthority: forwardedParams.approvalAuthority,
        });
        if (authorityError) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, authorityError, {
              details: { code: "APPROVAL_AUTHORITY_CLOSED" },
            }),
          );
          return;
        }
        const res = await context.nodeRegistry.invoke({
          nodeId,
          expectedConnId: nodeSession.connId,
          expectedPairingGeneration: generation.key,
          command,
          params: forwardedParams.params,
          timeoutMs: dispatchTimeoutMs,
          signal: invocationLifecycle,
          idempotencyKey: p.idempotencyKey,
          ...(sessionKey ? { sessionKey } : {}),
          isDispatchAuthorized: () =>
            resolveNodeInvokeRuntimeAuthorityError({
              context,
              client,
              approvalAuthority: forwardedParams.approvalAuthority,
            }) === undefined,
          onDispatchReady: () => {
            nodeCommandDispatched = true;
          },
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
            }) &&
            // Pending actions outlive this RPC. Closure-bound agent or approval
            // authority cannot be transferred to a later device pull.
            !client?.internal?.agentRuntimeIdentity &&
            !forwardedParams.approvalAuthority
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
          if (
            !respondUnavailableOnNodeInvokeErrorWithProvenance(respond, res, {
              nodeCommandDispatched,
            })
          ) {
            return;
          }
          return;
        }
        const payload = res.payloadJSON ? parseGatewayPayload(res.payloadJSON) : res.payload;
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
        releaseApprovalHandoff?.();
        releaseNodeWakeLifecycle(nodeId, wakeLifecycle);
      }
    });
  },
  "node.invoke.progress": handleNodeInvokeProgress,
  "node.invoke.result": handleNodeInvokeResult,
};
