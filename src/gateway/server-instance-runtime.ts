import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "../../packages/gateway-client/src/timeouts.js";
import type { AgentWaitParams } from "../../packages/gateway-protocol/src/index.js";
import { createOutboundSendDeps } from "../cli/outbound-send-deps.js";
import {
  GATEWAY_NATIVE_APPROVAL_METHODS,
  type GatewayNativeApprovalMethod,
} from "../infra/approval-gateway-runtime-methods.js";
import type {
  GatewayApprovalEventSubscriber,
  GatewayApprovalRequest,
  GatewayApprovalResolved,
} from "../infra/approval-gateway-runtime.types.js";
import { createApprovalNativeRouteCoordinator } from "../infra/approval-native-route-coordinator.js";
import type { ChannelApprovalKind } from "../infra/approval-types.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import type { GatewayMethodRegistry } from "./methods/registry.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type {
  GatewayInstanceAgentDispatchOptions,
  GatewayInstanceRuntime,
  GatewayRecoveryRuntime,
} from "./server-instance-runtime.types.js";
import type { AgentRunRequest } from "./server-methods/agent-request-types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { registerGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import {
  cancelSubagentCompletionToolHandoff,
  registerSubagentCompletionToolHandoff,
} from "./subagent-completion-tool-handoff.js";

const loadOutboundMessageRuntime = createLazyRuntimeModule(
  () => import("../infra/outbound/message.js"),
);

const RECOVERY_NOTICE_COMPLETION_RETENTION = {
  idPrefix: "main-session-restart-recovery:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

type GatewayInstanceRuntimeOptions = {
  getContext: () => GatewayRequestContext;
  getMethodRegistry: () => GatewayMethodRegistry;
  isDispatchAvailable: () => boolean;
  logError?: (message: string) => void;
};

/** Creates closed internal principals bound to one concrete Gateway lifecycle. */
export function createGatewayInstanceRuntime(
  options: GatewayInstanceRuntimeOptions,
): GatewayInstanceRuntime {
  const approvalSubscribers = new Set<GatewayApprovalEventSubscriber>();
  const routeCoordinator = createApprovalNativeRouteCoordinator();
  let closed = false;

  const assertDispatchAvailable = (method: string) => {
    if (closed || !options.isDispatchAvailable()) {
      throw new Error(`Gateway instance dispatch unavailable for ${method}`);
    }
  };

  const dispatch = async <T>(params: {
    allowedMethods: ReadonlySet<string>;
    client: ReturnType<typeof createSyntheticPluginRuntimeClient>;
    method: string;
    payload: Record<string, unknown>;
    timeoutMs?: number;
  }): Promise<T> => {
    assertDispatchAvailable(params.method);
    if (!params.allowedMethods.has(params.method)) {
      throw new Error(`Gateway internal principal cannot dispatch ${params.method}`);
    }
    return await dispatchGatewayRequestInProcess<T>(params.method, params.payload, {
      client: params.client,
      context: options.getContext(),
      methodRegistry: options.getMethodRegistry(),
      requestIdPrefix: "gateway-internal",
      timeoutMs: params.timeoutMs,
    });
  };

  const recoveryClient = createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] });
  const recoveryAgentTurns = createInternalAgentTurnFacade({
    client: recoveryClient,
    getContext: options.getContext,
    getMethodRegistry: options.getMethodRegistry,
  });
  const approvalClient = createSyntheticPluginRuntimeClient({ scopes: [APPROVALS_SCOPE] });
  const approvalMethods = new Set<GatewayNativeApprovalMethod>(GATEWAY_NATIVE_APPROVAL_METHODS);
  const approvalRouteClient = createSyntheticPluginRuntimeClient({ scopes: [WRITE_SCOPE] });
  const approvalRouteMethods = new Set(["send"]);

  const recovery: GatewayRecoveryRuntime = {
    dispatchAgent: async <T>(
      payload: AgentRunRequest,
      timeoutMs?: number,
      dispatchOptions: GatewayInstanceAgentDispatchOptions = {},
    ) => {
      assertDispatchAvailable("agent");
      const delegatedToolPolicyHandoffId = dispatchOptions.delegatedToolPolicyHandoff
        ? registerSubagentCompletionToolHandoff(dispatchOptions.delegatedToolPolicyHandoff)
        : undefined;
      const needsDedicatedPrincipal = Boolean(
        dispatchOptions.allowModelOverride === true ||
        dispatchOptions.allowSyntheticModelOverride === true ||
        dispatchOptions.allowSyntheticCronRunContinuation === true ||
        dispatchOptions.internalDeliveryMediaUrls ||
        dispatchOptions.internalDeliverySuppressText === true ||
        delegatedToolPolicyHandoffId ||
        dispatchOptions.scopes ||
        dispatchOptions.syntheticScopes,
      );
      const agentTurns = needsDedicatedPrincipal
        ? createInternalAgentTurnFacade({
            client: createSyntheticPluginRuntimeClient({
              allowModelOverride:
                dispatchOptions.allowModelOverride === true ||
                dispatchOptions.allowSyntheticModelOverride === true,
              cronRunContinuation: dispatchOptions.allowSyntheticCronRunContinuation === true,
              internalDeliveryMediaUrls: dispatchOptions.internalDeliveryMediaUrls,
              internalDeliverySuppressText: dispatchOptions.internalDeliverySuppressText,
              delegatedToolPolicyHandoffId,
              scopes: dispatchOptions.scopes ?? dispatchOptions.syntheticScopes,
            }),
            getContext: options.getContext,
            getMethodRegistry: options.getMethodRegistry,
          })
        : recoveryAgentTurns;
      try {
        return await agentTurns.dispatch<T>(payload, {
          expectFinal: dispatchOptions.expectFinal,
          onAccepted: dispatchOptions.onAccepted,
          onSignalAbort: dispatchOptions.onSignalAbort,
          signal: dispatchOptions.signal,
          timeoutMs,
        });
      } finally {
        cancelSubagentCompletionToolHandoff(delegatedToolPolicyHandoffId);
      }
    },
    waitForAgent: async <T>(payload: AgentWaitParams, timeoutMs?: number) => {
      assertDispatchAvailable("agent.wait");
      return await recoveryAgentTurns.wait<T>(payload, timeoutMs);
    },
    sendRecoveryNotice: async (payload) => {
      if (closed || !options.isDispatchAvailable()) {
        throw new Error("Gateway instance dispatch unavailable for recovery notice");
      }
      const { sendMessage } = await loadOutboundMessageRuntime();
      const context = options.getContext();
      const result = await sendMessage({
        cfg: context.getRuntimeConfig(),
        deps: createOutboundSendDeps(context.deps),
        channel: payload.channel,
        to: payload.to,
        accountId: payload.accountId,
        threadId: payload.threadId,
        content: payload.text,
        gatewayOwnedDelivery: true,
        bestEffort: true,
        idempotencyKey: payload.idempotencyKey,
        deliveryIntentId: payload.idempotencyKey,
        reusePendingDeliveryIntent: true,
        completionRetention: RECOVERY_NOTICE_COMPLETION_RETENTION,
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (result.deliveryStatus === "failed" || result.deliveryStatus === "partial_failed") {
        throw new Error(result.error ?? "recovery notice delivery failed");
      }
      return { suppressed: result.deliveryStatus === "suppressed" };
    },
  };
  const releaseRecoveryRuntime = registerGatewayRecoveryRuntime(recovery);

  const publish = (
    kind: ChannelApprovalKind,
    callback: (subscriber: GatewayApprovalEventSubscriber) => void,
    shouldDeliver?: (subscriber: GatewayApprovalEventSubscriber) => boolean,
  ): number => {
    if (closed) {
      return 0;
    }
    let delivered = 0;
    for (const subscriber of approvalSubscribers) {
      if (!subscriber.eventKinds.has(kind)) {
        continue;
      }
      try {
        if (shouldDeliver && !shouldDeliver(subscriber)) {
          continue;
        }
        callback(subscriber);
        delivered += 1;
      } catch (error) {
        options.logError?.(`internal approval subscriber failed: ${String(error)}`);
      }
    }
    return delivered;
  };

  return {
    approvalEvents: {
      publishRequested: (kind, request) =>
        publish(
          kind,
          (subscriber) => subscriber.onRequested(request as GatewayApprovalRequest),
          (subscriber) => subscriber.shouldHandle(request as GatewayApprovalRequest),
        ),
      publishResolved: (kind, resolved) => {
        publish(kind, (subscriber) => subscriber.onResolved(resolved as GatewayApprovalResolved));
      },
    },
    nativeApprovals: {
      request: async <T>(
        method: GatewayNativeApprovalMethod,
        payload: Record<string, unknown>,
        requestOptions?: { clientDisplayName?: string },
      ) =>
        await dispatch<T>({
          allowedMethods: approvalMethods,
          client: requestOptions?.clientDisplayName
            ? {
                ...approvalClient,
                connect: {
                  ...approvalClient.connect,
                  client: {
                    ...approvalClient.connect.client,
                    displayName: requestOptions.clientDisplayName,
                  },
                },
              }
            : approvalClient,
          method,
          payload,
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      requestRoute: async <T>(method: "send", payload: Record<string, unknown>) =>
        await dispatch<T>({
          allowedMethods: approvalRouteMethods,
          client: approvalRouteClient,
          method,
          payload,
          timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS,
        }),
      routeCoordinator,
      subscribe: (subscriber) => {
        if (closed) {
          throw new Error("Gateway instance approval runtime is closed");
        }
        approvalSubscribers.add(subscriber);
        let subscribed = true;
        return () => {
          if (!subscribed) {
            return;
          }
          subscribed = false;
          approvalSubscribers.delete(subscriber);
        };
      },
    },
    recovery,
    close: () => {
      closed = true;
      releaseRecoveryRuntime();
      approvalSubscribers.clear();
      routeCoordinator.close();
    },
  };
}
