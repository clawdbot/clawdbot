import type { CommandEntry } from "../../../packages/gateway-protocol/src/index.js";
import type { ApplicationContext } from "./context.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";

export type CommandClientPresentationAction = NonNullable<
  CommandEntry["clientPresentation"]
>["action"];

export async function dispatchCommandClientPresentation(
  context: ApplicationContext,
  action: CommandClientPresentationAction,
): Promise<boolean> {
  switch (action.kind) {
    case "device-pairing": {
      const gateway = context.gateway.snapshot;
      // Pairing-scoped callers stay remote so the plugin can preserve its limited handoff;
      // opening the administrator modal would replace that narrower authorization contract.
      if (gateway.phase !== "connected" || !readGatewayOperatorAccess(gateway).canAdmin) {
        return false;
      }
      return context.overlays.openDevicePairSetup();
    }
    default: {
      action.kind satisfies never;
      return false;
    }
  }
}
