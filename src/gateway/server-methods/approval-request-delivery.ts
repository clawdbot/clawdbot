// Approval request delivery fans out external routes while preserving the
// approval record's visibility boundary for iOS targets.
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { ExecApprovalRecord } from "../exec-approval-manager.js";
import { isApprovalRecordVisibleToClient } from "./approval-shared.js";
import type { GatewayClient } from "./types.js";

type ApprovalRequestDeliveryTarget = {
  deviceId: string;
  scopes: readonly string[];
};

type ApprovalRequestDelivery = readonly [
  run: (isTargetVisible: (target: ApprovalRequestDeliveryTarget) => boolean) => Promise<boolean>,
  errorLabel: string,
];

type ApprovalDeliveryLogContext = { logGateway?: { error?: (message: string) => void } };

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
      run(isTargetVisible).catch((err: unknown) => {
        params.context.logGateway?.error?.(`${errorLabel}: ${String(err)}`);
        return false;
      }),
    ];
  });
  if (deliveryTasks.length === 0) {
    return false;
  }
  return Promise.all(deliveryTasks).then((results) => results.some(Boolean));
}
