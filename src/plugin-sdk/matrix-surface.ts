// Manual facade. Keep loader boundary explicit.
import type {
  BindingTargetKind,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import {
  createLazyFacadeArrayValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

export type MatrixFacadeAuth = {
  accountId: string;
  homeserver: string;
  userId: string;
  accessToken: string;
  password?: string;
  deviceId?: string;
  deviceName?: string;
  initialSyncLimit?: number;
  encryption?: boolean;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: unknown;
  dispatcherPolicy?: unknown;
};

export type MatrixThreadBindingTargetKind = "subagent" | "acp";

export type MatrixThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetKind: MatrixThreadBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export type MatrixThreadBindingManager = {
  accountId: string;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => MatrixThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => MatrixThreadBindingRecord[];
  listBindings: () => MatrixThreadBindingRecord[];
  touchBinding: (bindingId: string, at?: number) => MatrixThreadBindingRecord | null;
  setIdleTimeoutBySessionKey: (params: {
    targetSessionKey: string;
    idleTimeoutMs: number;
  }) => MatrixThreadBindingRecord[];
  setMaxAgeBySessionKey: (params: {
    targetSessionKey: string;
    maxAgeMs: number;
  }) => MatrixThreadBindingRecord[];
  persist: () => Promise<void>;
  stop: () => void;
};

type MatrixThreadBindingManagerFactory = (params: {
  accountId: string;
  auth: MatrixFacadeAuth;
  client: unknown;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}) => Promise<MatrixThreadBindingManager>;

type FacadeModule = {
  createMatrixThreadBindingManager: MatrixThreadBindingManagerFactory;
  matrixSessionBindingAdapterChannels: readonly ["matrix"];
  resetMatrixThreadBindingsForTests: () => void;
};

export type MatrixSessionBindingTimeoutParams = {
  accountId: string;
  targetSessionKey: string;
  idleTimeoutMs: number;
};

export type MatrixSessionBindingMaxAgeParams = {
  accountId: string;
  targetSessionKey: string;
  maxAgeMs: number;
};

export type MatrixSessionBindingTimeoutSetter = (
  params: MatrixSessionBindingTimeoutParams,
) => SessionBindingRecord[];

export type MatrixSessionBindingMaxAgeSetter = (
  params: MatrixSessionBindingMaxAgeParams,
) => SessionBindingRecord[];

export type MatrixSessionBindingTargetKind = BindingTargetKind;

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "matrix",
    artifactBasename: "api.js",
  });
}
export const createMatrixThreadBindingManager: FacadeModule["createMatrixThreadBindingManager"] = ((
  ...args
) =>
  loadFacadeModule()["createMatrixThreadBindingManager"](
    ...args,
  )) as FacadeModule["createMatrixThreadBindingManager"];
export const matrixSessionBindingAdapterChannels: FacadeModule["matrixSessionBindingAdapterChannels"] =
  createLazyFacadeArrayValue(
    () =>
      loadFacadeModule()["matrixSessionBindingAdapterChannels"] as unknown as readonly unknown[],
  ) as FacadeModule["matrixSessionBindingAdapterChannels"];
export const resetMatrixThreadBindingsForTests: FacadeModule["resetMatrixThreadBindingsForTests"] =
  ((...args) =>
    loadFacadeModule()["resetMatrixThreadBindingsForTests"](
      ...args,
    )) as FacadeModule["resetMatrixThreadBindingsForTests"];
