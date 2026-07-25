// Manual facade. Keep loader boundary explicit.
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import {
  createLazyFacadeObjectValue,
  loadBundledPluginPublicSurfaceModuleSync,
} from "./facade-loader.js";
import type {
  QaBusAttachment,
  QaBusInboundMessageInput,
  QaBusMessage,
  QaBusPollResult,
  QaBusSearchMessagesInput,
  QaBusStateSnapshot,
  QaBusThread,
  QaBusToolCall,
} from "./qa-channel-protocol.js";

export type * from "./qa-channel-protocol.js";

type QaTargetParts = {
  chatType: "direct" | "channel" | "group";
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
    toolCalls?: QaBusToolCall[];
  }) => Promise<{ message: QaBusMessage }>;
  setQaChannelRuntime: (runtime: unknown) => void;
};

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "qa-channel",
    artifactBasename: "api.js",
  });
}

/** Build a QA bus target string from conversation and optional thread parts. */
export const buildQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

/** Format a QA bus target string for display and CLI output. */
export const formatQaTarget: FacadeModule["buildQaTarget"] = ((...args) =>
  loadFacadeModule().buildQaTarget(...args)) as FacadeModule["buildQaTarget"];

/** Create a QA bus thread through the bundled QA channel facade. */
export const createQaBusThread: FacadeModule["createQaBusThread"] = ((...args) =>
  loadFacadeModule().createQaBusThread(...args)) as FacadeModule["createQaBusThread"];

/** Delete a QA bus message through the bundled QA channel facade. */
export const deleteQaBusMessage: FacadeModule["deleteQaBusMessage"] = ((...args) =>
  loadFacadeModule().deleteQaBusMessage(...args)) as FacadeModule["deleteQaBusMessage"];

/** Edit a QA bus message through the bundled QA channel facade. */
export const editQaBusMessage: FacadeModule["editQaBusMessage"] = ((...args) =>
  loadFacadeModule().editQaBusMessage(...args)) as FacadeModule["editQaBusMessage"];

/** Read the current QA bus state snapshot. */
export const getQaBusState: FacadeModule["getQaBusState"] = ((...args) =>
  loadFacadeModule().getQaBusState(...args)) as FacadeModule["getQaBusState"];

/** Inject an inbound QA bus message for channel and gateway tests. */
export const injectQaBusInboundMessage: FacadeModule["injectQaBusInboundMessage"] = ((...args) =>
  loadFacadeModule().injectQaBusInboundMessage(
    ...args,
  )) as FacadeModule["injectQaBusInboundMessage"];

/** Normalize a user-provided QA target string when possible. */
export const normalizeQaTarget: FacadeModule["normalizeQaTarget"] = ((...args) =>
  loadFacadeModule().normalizeQaTarget(...args)) as FacadeModule["normalizeQaTarget"];

/** Parse a QA target string into chat type, conversation id, and optional thread id. */
export const parseQaTarget: FacadeModule["parseQaTarget"] = ((...args) =>
  loadFacadeModule().parseQaTarget(...args)) as FacadeModule["parseQaTarget"];

/** Poll the QA bus for new messages from a cursor. */
export const pollQaBus: FacadeModule["pollQaBus"] = ((...args) =>
  loadFacadeModule().pollQaBus(...args)) as FacadeModule["pollQaBus"];

/** Lazy QA channel plugin object used by plugin loader tests. */
export const qaChannelPlugin: FacadeModule["qaChannelPlugin"] = createLazyFacadeObjectValue(
  () => loadFacadeModule().qaChannelPlugin,
);

/** Add a reaction to a QA bus message. */
export const reactToQaBusMessage: FacadeModule["reactToQaBusMessage"] = ((...args) =>
  loadFacadeModule().reactToQaBusMessage(...args)) as FacadeModule["reactToQaBusMessage"];

/** Read one QA bus message by id. */
export const readQaBusMessage: FacadeModule["readQaBusMessage"] = ((...args) =>
  loadFacadeModule().readQaBusMessage(...args)) as FacadeModule["readQaBusMessage"];

/** Search QA bus messages using the bundled channel facade. */
export const searchQaBusMessages: FacadeModule["searchQaBusMessages"] = ((...args) =>
  loadFacadeModule().searchQaBusMessages(...args)) as FacadeModule["searchQaBusMessages"];

/** Send an outbound QA bus message with optional attachments and tool calls. */
export const sendQaBusMessage: FacadeModule["sendQaBusMessage"] = ((...args) =>
  loadFacadeModule().sendQaBusMessage(...args)) as FacadeModule["sendQaBusMessage"];

/** Install a test runtime implementation into the bundled QA channel facade. */
export const setQaChannelRuntime: FacadeModule["setQaChannelRuntime"] = ((...args) =>
  loadFacadeModule().setQaChannelRuntime(...args)) as FacadeModule["setQaChannelRuntime"];
