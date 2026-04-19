// Manual facade. Keep loader boundary explicit.
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { loadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

export type MatrixResolvedStringField =
  | "homeserver"
  | "userId"
  | "accessToken"
  | "password"
  | "deviceId"
  | "deviceName";

export type MatrixResolvedStringValues = Record<MatrixResolvedStringField, string>;

type MatrixStringSourceMap = Partial<Record<MatrixResolvedStringField, string>>;

type FacadeModule = {
  resolveMatrixAccountStringValues: (params: {
    accountId: string;
    account?: MatrixStringSourceMap;
    scopedEnv?: MatrixStringSourceMap;
    channel?: MatrixStringSourceMap;
    globalEnv?: MatrixStringSourceMap;
  }) => MatrixResolvedStringValues;
  setMatrixRuntime: (runtime: PluginRuntime) => void;
};

function loadFacadeModule(): FacadeModule {
  return loadActivatedBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "runtime-api.js",
  });
}
export const resolveMatrixAccountStringValues: FacadeModule["resolveMatrixAccountStringValues"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixAccountStringValues"](
    ...args,
  )) as FacadeModule["resolveMatrixAccountStringValues"];
export const setMatrixRuntime: FacadeModule["setMatrixRuntime"] = ((...args) =>
  loadFacadeModule()["setMatrixRuntime"](...args)) as FacadeModule["setMatrixRuntime"];
