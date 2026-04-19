// Manual facade. Keep loader boundary explicit.
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export type MatrixScopedEnvVarNames = {
  homeserver: string;
  userId: string;
  accessToken: string;
  password: string;
  deviceId: string;
  deviceName: string;
};

export type MatrixAccountStorageRoot = {
  rootDir: string;
  accountKey: string;
  tokenHash: string;
};

export type MatrixLegacyFlatStoragePaths = {
  rootDir: string;
  storagePath: string;
  cryptoPath: string;
};

type FacadeModule = {
  findMatrixAccountEntry: (
    cfg: OpenClawConfig,
    accountId: string,
  ) => Record<string, unknown> | null;
  getMatrixScopedEnvVarNames: (accountId: string) => MatrixScopedEnvVarNames;
  requiresExplicitMatrixDefaultAccount: (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => boolean;
  resolveConfiguredMatrixAccountIds: (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => string[];
  resolveMatrixAccountStorageRoot: (params: {
    stateDir: string;
    homeserver: string;
    userId: string;
    accessToken: string;
    accountId?: string | null;
  }) => MatrixAccountStorageRoot;
  resolveMatrixChannelConfig: (cfg: OpenClawConfig) => Record<string, unknown> | null;
  resolveMatrixCredentialsDir: (stateDir: string) => string;
  resolveMatrixCredentialsPath: (params: { stateDir: string; accountId?: string | null }) => string;
  resolveMatrixDefaultOrOnlyAccountId: (cfg: OpenClawConfig, env?: NodeJS.ProcessEnv) => string;
  resolveMatrixLegacyFlatStoragePaths: (stateDir: string) => MatrixLegacyFlatStoragePaths;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "api.js",
  });
}
export const findMatrixAccountEntry: FacadeModule["findMatrixAccountEntry"] = ((...args) =>
  loadFacadeModule()["findMatrixAccountEntry"](...args)) as FacadeModule["findMatrixAccountEntry"];
export const getMatrixScopedEnvVarNames: FacadeModule["getMatrixScopedEnvVarNames"] = ((...args) =>
  loadFacadeModule()["getMatrixScopedEnvVarNames"](
    ...args,
  )) as FacadeModule["getMatrixScopedEnvVarNames"];
export const requiresExplicitMatrixDefaultAccount: FacadeModule["requiresExplicitMatrixDefaultAccount"] =
  ((...args) =>
    loadFacadeModule()["requiresExplicitMatrixDefaultAccount"](
      ...args,
    )) as FacadeModule["requiresExplicitMatrixDefaultAccount"];
export const resolveConfiguredMatrixAccountIds: FacadeModule["resolveConfiguredMatrixAccountIds"] =
  ((...args) =>
    loadFacadeModule()["resolveConfiguredMatrixAccountIds"](
      ...args,
    )) as FacadeModule["resolveConfiguredMatrixAccountIds"];
export const resolveMatrixAccountStorageRoot: FacadeModule["resolveMatrixAccountStorageRoot"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixAccountStorageRoot"](
    ...args,
  )) as FacadeModule["resolveMatrixAccountStorageRoot"];
export const resolveMatrixChannelConfig: FacadeModule["resolveMatrixChannelConfig"] = ((...args) =>
  loadFacadeModule()["resolveMatrixChannelConfig"](
    ...args,
  )) as FacadeModule["resolveMatrixChannelConfig"];
export const resolveMatrixCredentialsDir: FacadeModule["resolveMatrixCredentialsDir"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixCredentialsDir"](
    ...args,
  )) as FacadeModule["resolveMatrixCredentialsDir"];
export const resolveMatrixCredentialsPath: FacadeModule["resolveMatrixCredentialsPath"] = ((
  ...args
) =>
  loadFacadeModule()["resolveMatrixCredentialsPath"](
    ...args,
  )) as FacadeModule["resolveMatrixCredentialsPath"];
export const resolveMatrixDefaultOrOnlyAccountId: FacadeModule["resolveMatrixDefaultOrOnlyAccountId"] =
  ((...args) =>
    loadFacadeModule()["resolveMatrixDefaultOrOnlyAccountId"](
      ...args,
    )) as FacadeModule["resolveMatrixDefaultOrOnlyAccountId"];
export const resolveMatrixLegacyFlatStoragePaths: FacadeModule["resolveMatrixLegacyFlatStoragePaths"] =
  ((...args) =>
    loadFacadeModule()["resolveMatrixLegacyFlatStoragePaths"](
      ...args,
    )) as FacadeModule["resolveMatrixLegacyFlatStoragePaths"];
