// Manual facade. Keep loader boundary explicit.
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";

export type QaBusConversationKind = "direct" | "channel";

export type QaBusConversation = {
  id: string;
  kind: QaBusConversationKind;
  title?: string;
};

export type QaBusAttachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  mimeType: string;
  fileName?: string;
  inline?: boolean;
  url?: string;
  contentBase64?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  altText?: string;
  transcript?: string;
};

export type QaBusMessage = {
  id: string;
  accountId: string;
  direction: "inbound" | "outbound";
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  deleted?: boolean;
  editedAt?: number;
  attachments?: QaBusAttachment[];
  reactions: Array<{
    emoji: string;
    senderId: string;
    timestamp: number;
  }>;
};

export type QaBusThread = {
  id: string;
  accountId: string;
  conversationId: string;
  title: string;
  createdAt: number;
  createdBy: string;
};

export type QaBusEvent =
  | { cursor: number; kind: "inbound-message"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "outbound-message"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "thread-created"; accountId: string; thread: QaBusThread }
  | { cursor: number; kind: "message-edited"; accountId: string; message: QaBusMessage }
  | { cursor: number; kind: "message-deleted"; accountId: string; message: QaBusMessage }
  | {
      cursor: number;
      kind: "reaction-added";
      accountId: string;
      message: QaBusMessage;
      emoji: string;
      senderId: string;
    };

export type QaBusInboundMessageInput = {
  accountId?: string;
  conversation: QaBusConversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  threadTitle?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
};

export type QaBusOutboundMessageInput = {
  accountId?: string;
  to: string;
  senderId?: string;
  senderName?: string;
  text: string;
  timestamp?: number;
  threadId?: string;
  replyToId?: string;
  attachments?: QaBusAttachment[];
};

export type QaBusCreateThreadInput = {
  accountId?: string;
  conversationId: string;
  title: string;
  createdBy?: string;
  timestamp?: number;
};

export type QaBusReactToMessageInput = {
  accountId?: string;
  messageId: string;
  emoji: string;
  senderId?: string;
  timestamp?: number;
};

export type QaBusEditMessageInput = {
  accountId?: string;
  messageId: string;
  text: string;
  timestamp?: number;
};

export type QaBusDeleteMessageInput = {
  accountId?: string;
  messageId: string;
  timestamp?: number;
};

export type QaBusSearchMessagesInput = {
  accountId?: string;
  query?: string;
  conversationId?: string;
  threadId?: string;
  limit?: number;
};

export type QaBusReadMessageInput = {
  accountId?: string;
  messageId: string;
};

export type QaBusPollInput = {
  accountId?: string;
  cursor?: number;
  timeoutMs?: number;
  limit?: number;
};

export type QaBusPollResult = {
  cursor: number;
  events: QaBusEvent[];
};

export type QaBusStateSnapshot = {
  cursor: number;
  conversations: QaBusConversation[];
  threads: QaBusThread[];
  messages: QaBusMessage[];
  events: QaBusEvent[];
};

export type QaBusWaitForInput =
  | {
      timeoutMs?: number;
      kind: "event-kind";
      eventKind: QaBusEvent["kind"];
    }
  | {
      timeoutMs?: number;
      kind: "message-text";
      textIncludes: string;
      direction?: QaBusMessage["direction"];
    }
  | {
      timeoutMs?: number;
      kind: "thread-id";
      threadId: string;
    };

type QaTargetParts = {
  chatType: "direct" | "channel";
  conversationId: string;
  threadId?: string;
};

type FacadeModule = {
  buildQaTarget: (params: QaTargetParts & { threadId?: string | null }) => string;
  formatQaTarget: (params: QaTargetParts & { threadId?: string | null }) => string;
  createQaBusThread: (params: {
    baseUrl: string;
    accountId: string;
    conversationId: string;
    title: string;
    createdBy?: string;
  }) => Promise<{ thread: QaBusThread }>;
  deleteQaBusMessage: (params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
  }) => Promise<{ message: QaBusMessage }>;
  editQaBusMessage: (params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
    text: string;
  }) => Promise<{ message: QaBusMessage }>;
  getQaBusState: (baseUrl: string) => Promise<QaBusStateSnapshot>;
  injectQaBusInboundMessage: (params: {
    baseUrl: string;
    input: QaBusInboundMessageInput;
  }) => Promise<{ message: QaBusMessage }>;
  normalizeQaTarget: (raw: string) => string | undefined;
  parseQaTarget: (raw: string) => QaTargetParts;
  pollQaBus: (params: {
    baseUrl: string;
    accountId: string;
    cursor: number;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<QaBusPollResult>;
  qaChannelPlugin: ChannelPlugin;
  reactToQaBusMessage: (params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
    emoji: string;
    senderId?: string;
  }) => Promise<{ message: QaBusMessage }>;
  readQaBusMessage: (params: {
    baseUrl: string;
    accountId: string;
    messageId: string;
  }) => Promise<{ message: QaBusMessage }>;
  searchQaBusMessages: (params: {
    baseUrl: string;
    input: QaBusSearchMessagesInput;
  }) => Promise<{ messages: QaBusMessage[] }>;
  sendQaBusMessage: (params: {
    baseUrl: string;
    accountId: string;
    to: string;
    text: string;
    senderId?: string;
    senderName?: string;
    threadId?: string;
    replyToId?: string;
    attachments?: QaBusAttachment[];
  }) => Promise<{ message: QaBusMessage }>;
  setQaChannelRuntime: (runtime: unknown) => void;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "qa-channel",
    artifactBasename: "api.js",
  });
}

export const buildQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

export const formatQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

export const createQaBusThread: FacadeModule["createQaBusThread"] = ((...args) =>
  loadFacadeModule().createQaBusThread(...args)) as FacadeModule["createQaBusThread"];

export const deleteQaBusMessage: FacadeModule["deleteQaBusMessage"] = ((...args) =>
  loadFacadeModule().deleteQaBusMessage(...args)) as FacadeModule["deleteQaBusMessage"];

export const editQaBusMessage: FacadeModule["editQaBusMessage"] = ((...args) =>
  loadFacadeModule().editQaBusMessage(...args)) as FacadeModule["editQaBusMessage"];

export const getQaBusState: FacadeModule["getQaBusState"] = ((...args) =>
  loadFacadeModule().getQaBusState(...args)) as FacadeModule["getQaBusState"];

export const injectQaBusInboundMessage: FacadeModule["injectQaBusInboundMessage"] = ((...args) =>
  loadFacadeModule().injectQaBusInboundMessage(
    ...args,
  )) as FacadeModule["injectQaBusInboundMessage"];

export const normalizeQaTarget: FacadeModule["normalizeQaTarget"] = ((...args) =>
  loadFacadeModule().normalizeQaTarget(...args)) as FacadeModule["normalizeQaTarget"];

export const parseQaTarget: FacadeModule["parseQaTarget"] = ((...args) =>
  loadFacadeModule().parseQaTarget(...args)) as FacadeModule["parseQaTarget"];

export const pollQaBus: FacadeModule["pollQaBus"] = ((...args) =>
  loadFacadeModule().pollQaBus(...args)) as FacadeModule["pollQaBus"];

export const qaChannelPlugin: FacadeModule["qaChannelPlugin"] = createLazyFacadeObjectValue(
  () => loadFacadeModule().qaChannelPlugin,
);

export const reactToQaBusMessage: FacadeModule["reactToQaBusMessage"] = ((...args) =>
  loadFacadeModule().reactToQaBusMessage(...args)) as FacadeModule["reactToQaBusMessage"];

export const readQaBusMessage: FacadeModule["readQaBusMessage"] = ((...args) =>
  loadFacadeModule().readQaBusMessage(...args)) as FacadeModule["readQaBusMessage"];

export const searchQaBusMessages: FacadeModule["searchQaBusMessages"] = ((...args) =>
  loadFacadeModule().searchQaBusMessages(...args)) as FacadeModule["searchQaBusMessages"];

export const sendQaBusMessage: FacadeModule["sendQaBusMessage"] = ((...args) =>
  loadFacadeModule().sendQaBusMessage(...args)) as FacadeModule["sendQaBusMessage"];

export const setQaChannelRuntime: FacadeModule["setQaChannelRuntime"] = ((...args) =>
  loadFacadeModule().setQaChannelRuntime(...args)) as FacadeModule["setQaChannelRuntime"];
