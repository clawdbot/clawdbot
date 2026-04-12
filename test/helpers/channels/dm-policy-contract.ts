import type { SignalSender } from "@openclaw/signal/contract-api.js";
import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type SignalContractApiSurface = Pick<
  typeof import("@openclaw/signal/contract-api.js"),
  "isSignalSenderAllowed"
>;

let signalContractSurface: SignalContractApiSurface | undefined;

function getSignalContractSurface(): SignalContractApiSurface {
  signalContractSurface ??= loadBundledPluginContractApiSync<SignalContractApiSurface>("signal");
  return signalContractSurface;
}

export const isSignalSenderAllowed = (
  ...args: Parameters<SignalContractApiSurface["isSignalSenderAllowed"]>
) => getSignalContractSurface().isSignalSenderAllowed(...args);
export type { SignalSender };
