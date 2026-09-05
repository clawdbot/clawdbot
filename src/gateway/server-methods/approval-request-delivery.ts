// Approval request delivery fans out external routes while preserving the
// approval record's visibility boundary for mobile and browser push targets.
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import { runWithRetainedGatewayRootWork } from "../../process/gateway-work-admission.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { isApprovalRecordVisibleToClient } from "./approval-shared.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

type ApprovalRequestDeliveryTarget = {
  deviceId: string;
  scopes: readonly string[];
};

type ApprovalRequestDelivery = readonly [
  run: (isTargetVisible: (target: ApprovalRequestDeliveryTarget) => boolean) => Promise<boolean>,
  errorLabel: string,
];

type ApprovalDeliveryLogContext = {
  approvalWebPushDelivery?: Pick<
    NonNullable<GatewayRequestContext["approvalWebPushDelivery"]>,
    "handleRequested"
  >;
  logGateway?: { error?: (message: string) => void };
};

function trackApprovalDelivery<T>(run: () => Promise<T>): Promise<T> {
  return trackAsyncWork(() => runWithRetainedGatewayRootWork(run));
}

function resolveFirstSuccessfulApprovalDelivery(
  deliveryTasks: readonly Promise<boolean>[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let remaining = deliveryTasks.length;
    for (const delivery of deliveryTasks) {
      void delivery.then((delivered) => {
        if (delivered) {
          resolve(true);
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          resolve(false);
        }
      });
    }
  });
}

/** Runs external approval deliveries concurrently and reports whether any route accepted. */
export function runApprovalRequestDeliveries<TPayload>(params: {
  context: ApprovalDeliveryLogContext;
  record: ExecApprovalRecord<TPayload>;
  forward?: ApprovalRequestDelivery;
  iosPush?: ApprovalRequestDelivery;
}): boolean | Promise<boolean> {
  const isTargetVisible = (target: ApprovalRequestDeliveryTarget) =>
    isApprovalRecordVisibleToClient({
      record: params.record,
      client: {
        connect: {
          client: { id: GATEWAY_CLIENT_IDS.IOS_APP },
          device: { id: target.deviceId },
          scopes: [...target.scopes],
        },
      } as GatewayClient,
    });
  const deliveryTasks = [params.forward, params.iosPush].flatMap((delivery) => {
    if (!delivery) {
      return [];
    }
    const [run, errorLabel] = delivery;
    return [
      trackApprovalDelivery(() => run(isTargetVisible)).catch((err: unknown) => {
        params.context.logGateway?.error?.(`${errorLabel}: ${String(err)}`);
        return false;
      }),
    ];
  });
  try {
    const webPushDelivery = params.context.approvalWebPushDelivery?.handleRequested(params.record);
    if (webPushDelivery !== false && webPushDelivery !== undefined) {
      deliveryTasks.push(
        trackApprovalDelivery(() => Promise.resolve(webPushDelivery)).catch((err: unknown) => {
          params.context.logGateway?.error?.(`approval Web Push request failed: ${String(err)}`);
          return false;
        }),
      );
    }
  } catch (err) {
    params.context.logGateway?.error?.(`approval Web Push request failed: ${String(err)}`);
  }
  if (deliveryTasks.length === 0) {
    return false;
  }
  // A delivered route must unblock approval while other started routes keep
  // their error handlers and can finish without delaying the requester.
  return resolveFirstSuccessfulApprovalDelivery(deliveryTasks);
}
