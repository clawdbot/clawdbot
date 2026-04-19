// Manual facade. Keep loader boundary explicit.
import type { OpenClawConfig } from "../config/types.js";
import type { BindingTargetKind } from "../infra/outbound/session-binding-service.js";
import {
  createLazyFacadeArrayValue,
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

type FeishuGroupSessionScope = "group" | "group_sender" | "group_topic" | "group_topic_sender";

type FeishuThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  deliveryTo?: string;
  deliveryThreadId?: string;
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
};

type FeishuThreadBindingManager = {
  accountId: string;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  bindConversation: (params: {
    conversationId: string;
    parentConversationId?: string;
    targetKind: BindingTargetKind;
    targetSessionKey: string;
    metadata?: Record<string, unknown>;
  }) => FeishuThreadBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (conversationId: string) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  stop: () => void;
};

type FacadeModule = {
  buildFeishuConversationId: (params: {
    chatId: string;
    scope: FeishuGroupSessionScope;
    senderOpenId?: string;
    topicId?: string;
  }) => string;
  createFeishuThreadBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => FeishuThreadBindingManager;
  feishuSessionBindingAdapterChannels: readonly ["feishu"];
  feishuThreadBindingTesting: {
    resetFeishuThreadBindingsForTests: () => void;
  };
  parseFeishuDirectConversationId: (raw: unknown) => string | undefined;
  parseFeishuConversationId: (params: {
    conversationId: string;
    parentConversationId?: string;
  }) => {
    canonicalConversationId: string;
    chatId: string;
    topicId?: string;
    senderOpenId?: string;
    scope: FeishuGroupSessionScope;
  } | null;
  parseFeishuTargetId: (raw: unknown) => string | undefined;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "feishu",
    artifactBasename: "contract-api.js",
  });
}
export const buildFeishuConversationId: FacadeModule["buildFeishuConversationId"] = ((...args) =>
  loadFacadeModule()["buildFeishuConversationId"](
    ...args,
  )) as FacadeModule["buildFeishuConversationId"];
export const createFeishuThreadBindingManager: FacadeModule["createFeishuThreadBindingManager"] = ((
  ...args
) =>
  loadFacadeModule()["createFeishuThreadBindingManager"](
    ...args,
  )) as FacadeModule["createFeishuThreadBindingManager"];
export const feishuSessionBindingAdapterChannels: FacadeModule["feishuSessionBindingAdapterChannels"] =
  createLazyFacadeArrayValue(
    () =>
      loadFacadeModule()["feishuSessionBindingAdapterChannels"] as unknown as readonly unknown[],
  ) as FacadeModule["feishuSessionBindingAdapterChannels"];
export const feishuThreadBindingTesting: FacadeModule["feishuThreadBindingTesting"] =
  createLazyFacadeObjectValue(
    () => loadFacadeModule()["feishuThreadBindingTesting"] as object,
  ) as FacadeModule["feishuThreadBindingTesting"];
export const parseFeishuDirectConversationId: FacadeModule["parseFeishuDirectConversationId"] = ((
  ...args
) =>
  loadFacadeModule()["parseFeishuDirectConversationId"](
    ...args,
  )) as FacadeModule["parseFeishuDirectConversationId"];
export const parseFeishuConversationId: FacadeModule["parseFeishuConversationId"] = ((...args) =>
  loadFacadeModule()["parseFeishuConversationId"](
    ...args,
  )) as FacadeModule["parseFeishuConversationId"];
export const parseFeishuTargetId: FacadeModule["parseFeishuTargetId"] = ((...args) =>
  loadFacadeModule()["parseFeishuTargetId"](...args)) as FacadeModule["parseFeishuTargetId"];
