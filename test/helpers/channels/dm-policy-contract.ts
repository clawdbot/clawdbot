import type { SignalSender } from "@openclaw/signal/contract-api.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type SignalContractApiSurface = Pick<
  typeof import("@openclaw/signal/contract-api.js"),
  "isSignalSenderAllowed"
>;

let signalContractSurface: Promise<SignalContractApiSurface> | undefined;

export function getSignalContractSurface(): Promise<SignalContractApiSurface> {
  signalContractSurface ??= import(
    resolveRelativeBundledPluginPublicModuleId({
      fromModuleUrl: import.meta.url,
      pluginId: "signal",
      artifactBasename: "contract-api.js",
    })
  ) as Promise<SignalContractApiSurface>;
  return signalContractSurface;
}
export type { SignalSender };
