// Manual facade. Keep loader boundary explicit.
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

type FacadeModule = {
  setMatrixThreadBindingIdleTimeoutBySessionKey: (params: {
    accountId: string;
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => SessionBindingRecord[];
  setMatrixThreadBindingMaxAgeBySessionKey: (params: {
    accountId: string;
    targetSessionKey: string;
    maxAgeMs: number;
  }) => SessionBindingRecord[];
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "api.js",
  });
}
export const setMatrixThreadBindingIdleTimeoutBySessionKey: FacadeModule["setMatrixThreadBindingIdleTimeoutBySessionKey"] =
  ((...args) =>
    loadFacadeModule()["setMatrixThreadBindingIdleTimeoutBySessionKey"](
      ...args,
    )) as FacadeModule["setMatrixThreadBindingIdleTimeoutBySessionKey"];
export const setMatrixThreadBindingMaxAgeBySessionKey: FacadeModule["setMatrixThreadBindingMaxAgeBySessionKey"] =
  ((...args) =>
    loadFacadeModule()["setMatrixThreadBindingMaxAgeBySessionKey"](
      ...args,
    )) as FacadeModule["setMatrixThreadBindingMaxAgeBySessionKey"];
