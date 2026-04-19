import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

export type SignalSender = {
  kind: string;
  raw: string;
  e164?: string;
  uuid?: string;
  username?: string;
};

type SignalContractApiSurface = {
  isSignalSenderAllowed: (...args: unknown[]) => boolean;
};

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
