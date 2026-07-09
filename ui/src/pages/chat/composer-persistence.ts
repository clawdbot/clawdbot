import type {
  ChatAttachment,
  ChatQueueItem,
  ChatQueueSkillWorkshopRevision,
} from "../../lib/chat/chat-types.ts";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";
// Control UI chat module implements composer persistence behavior.
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

const STORAGE_KEY_PREFIX = "openclaw.control.chatComposer.v1:";
const MAX_STORED_SESSIONS = 20;
const MAX_STORED_QUEUE_ITEMS = 50;
const CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS = 200;
export const INTERRUPTED_MODEL_WAIT_ERROR =
  "Model selection was interrupted. Review and retry when ready.";

type ChatComposerPersistenceState = {
  settings?: { gatewayUrl?: string | null };
  assistantAgentId?: string | null;
  agentsList?: { defaultId?: string | null; mainKey?: string | null } | null;
  hello?: {
    snapshot?: unknown;
  } | null;
  sessionKey: string;
  chatMessage: string;
  chatQueue: ChatQueueItem[];
};

export type ChatComposerScope = Pick<
  ChatComposerPersistenceState,
  "settings" | "assistantAgentId" | "agentsList" | "hello"
>;

type StoredComposerSession = {
  draft?: string;
  queue?: ChatQueueItem[];
  updatedAt: number;
};

type StoredComposerState = {
  version: 1;
  sessions: Record<string, StoredComposerSession>;
};

type RestoreOptions = {
  preserveCurrent?: boolean;
  sessionKey?: string;
};

function storageKeyForGateway(gatewayUrl: string | null | undefined): string {
  const scope = gatewayUrl?.trim() || "default";
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(scope).slice(0, 240)}`;
}

function readHelloDefaultAgentId(state: Pick<ChatComposerPersistenceState, "hello">) {
  const snapshot = state.hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }
  const defaults = (snapshot as { sessionDefaults?: unknown }).sessionDefaults;
  if (!defaults || typeof defaults !== "object") {
    return undefined;
  }
  const defaultAgentId = (defaults as { defaultAgentId?: unknown }).defaultAgentId;
  return typeof defaultAgentId === "string" && defaultAgentId.trim()
    ? defaultAgentId.trim()
    : undefined;
}

function resolveComposerAgentScope(
  state: Pick<ChatComposerPersistenceState, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed) {
    return normalizeAgentId(parsed.agentId);
  }
  const defaultAgentId =
    state.assistantAgentId?.trim() ||
    state.agentsList?.defaultId?.trim() ||
    readHelloDefaultAgentId(state) ||
    DEFAULT_AGENT_ID;
  return normalizeAgentId(defaultAgentId);
}

function storageSessionKeyForState(
  state: Pick<ChatComposerPersistenceState, "assistantAgentId" | "agentsList" | "hello">,
  sessionKey: string,
): string {
  const agentId = resolveComposerAgentScope(state, sessionKey);
  return `${sessionKey}\u0000agent:${agentId}`;
}

function readStore(storage: Storage, key: string): StoredComposerState {
  const raw = storage.getItem(key);
  if (!raw) {
    return { version: 1, sessions: {} };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredComposerState>;
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.sessions ||
      typeof parsed.sessions !== "object"
    ) {
      return { version: 1, sessions: {} };
    }
    const sessions: Record<string, StoredComposerSession> = {};
    for (const [sessionKey, value] of Object.entries(parsed.sessions)) {
      const session = normalizeStoredSession(value);
      if (session) {
        sessions[sessionKey] = session;
      }
    }
    return { version: 1, sessions };
  } catch {
    return { version: 1, sessions: {} };
  }
}

function writeStore(storage: Storage, key: string, store: StoredComposerState): void {
  const entries = Object.entries(store.sessions)
    .toSorted((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, MAX_STORED_SESSIONS);
  if (entries.length === 0) {
    storage.removeItem(key);
    return;
  }
  storage.setItem(key, JSON.stringify({ version: 1, sessions: Object.fromEntries(entries) }));
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeChatAttachment(value: unknown): ChatAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const mimeType = normalizeOptionalString(entry.mimeType);
  if (!id || !mimeType) {
    return null;
  }
  const restored: ChatAttachment = { id, mimeType };
  const fileName = normalizeOptionalString(entry.fileName);
  if (fileName) {
    restored.fileName = fileName;
  }
  if (typeof entry.sizeBytes === "number" && Number.isFinite(entry.sizeBytes)) {
    restored.sizeBytes = entry.sizeBytes;
  }
  const dataUrl = normalizeOptionalString(entry.dataUrl);
  if (dataUrl) {
    restored.dataUrl = dataUrl;
  }
  return restored;
}

function serializeChatAttachment(attachment: ChatAttachment): ChatAttachment | null {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  if (!dataUrl) {
    return null;
  }
  return {
    id: attachment.id,
    mimeType: attachment.mimeType,
    ...(attachment.fileName ? { fileName: attachment.fileName } : {}),
    ...(typeof attachment.sizeBytes === "number" ? { sizeBytes: attachment.sizeBytes } : {}),
    dataUrl,
  };
}

function normalizeSkillWorkshopRevision(
  value: unknown,
): ChatQueueSkillWorkshopRevision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  const proposalId = normalizeOptionalString(entry.proposalId);
  if (!proposalId) {
    return undefined;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  return {
    proposalId,
    ...(agentId ? { agentId: normalizeAgentId(agentId) } : {}),
  };
}

function serializeQueueItem(item: ChatQueueItem): ChatQueueItem | null {
  const id = normalizeOptionalString(item.id);
  const text = typeof item.text === "string" ? item.text : "";
  if (!id || (!text.trim() && !item.attachments?.length)) {
    return null;
  }
  if (item.pendingRunId) {
    return null;
  }
  if (item.sendState === "sending") {
    return null;
  }
  const attachments = item.attachments?.map(serializeChatAttachment) ?? [];
  if (item.attachments?.length && attachments.some((attachment) => attachment === null)) {
    return null;
  }
  const sendState =
    item.sendState === "failed" ||
    item.sendState === "waiting-reconnect" ||
    item.sendState === "waiting-model"
      ? item.sendState
      : undefined;
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(item.skillWorkshopRevision);
  return {
    id,
    text,
    createdAt:
      typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
        ? item.createdAt
        : Date.now(),
    ...(item.kind === "queued" || item.kind === "steered" ? { kind: item.kind } : {}),
    ...(attachments.length ? { attachments: attachments as ChatAttachment[] } : {}),
    ...(typeof item.refreshSessions === "boolean" ? { refreshSessions: item.refreshSessions } : {}),
    ...(item.localCommandArgs ? { localCommandArgs: item.localCommandArgs } : {}),
    ...(item.localCommandName ? { localCommandName: item.localCommandName } : {}),
    ...(item.sessionKey ? { sessionKey: item.sessionKey } : {}),
    ...(item.agentId ? { agentId: item.agentId } : {}),
    ...(skillWorkshopRevision ? { skillWorkshopRevision } : {}),
    ...(sendState ? { sendState } : {}),
    ...(item.sendError ? { sendError: item.sendError } : {}),
    ...(item.sendRunId ? { sendRunId: item.sendRunId } : {}),
    ...(typeof item.sendAttempts === "number" && Number.isFinite(item.sendAttempts)
      ? { sendAttempts: item.sendAttempts }
      : {}),
  };
}

function normalizeQueueItem(value: unknown): ChatQueueItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const id = normalizeOptionalString(entry.id);
  const text = typeof entry.text === "string" ? entry.text : "";
  const createdAt =
    typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt)
      ? entry.createdAt
      : Date.now();
  if (!id || (!text.trim() && !Array.isArray(entry.attachments))) {
    return null;
  }
  const attachments = Array.isArray(entry.attachments)
    ? entry.attachments
        .map(normalizeChatAttachment)
        .filter((item): item is ChatAttachment => item !== null)
    : [];
  const item: ChatQueueItem = { id, text, createdAt };
  if (entry.kind === "queued" || entry.kind === "steered") {
    item.kind = entry.kind;
  }
  if (attachments.length) {
    item.attachments = attachments;
  }
  const refreshSessions = normalizeOptionalBoolean(entry.refreshSessions);
  if (refreshSessions !== undefined) {
    item.refreshSessions = refreshSessions;
  }
  if (entry.sendState === "failed" || entry.sendState === "waiting-reconnect") {
    item.sendState = entry.sendState;
  } else if (entry.sendState === "waiting-model") {
    item.sendState = "failed";
    item.sendError = INTERRUPTED_MODEL_WAIT_ERROR;
  }
  const sendError = normalizeOptionalString(entry.sendError);
  if (sendError) {
    item.sendError = sendError;
  }
  const sendRunId = normalizeOptionalString(entry.sendRunId);
  if (sendRunId) {
    item.sendRunId = sendRunId;
  }
  if (typeof entry.sendAttempts === "number" && Number.isFinite(entry.sendAttempts)) {
    item.sendAttempts = entry.sendAttempts;
  }
  const localCommandArgs = normalizeOptionalString(entry.localCommandArgs);
  if (localCommandArgs) {
    item.localCommandArgs = localCommandArgs;
  }
  const localCommandName = normalizeOptionalString(entry.localCommandName);
  if (localCommandName) {
    item.localCommandName = localCommandName;
  }
  const sessionKey = normalizeOptionalString(entry.sessionKey);
  if (sessionKey) {
    item.sessionKey = sessionKey;
  }
  const agentId = normalizeOptionalString(entry.agentId);
  if (agentId) {
    item.agentId = normalizeAgentId(agentId);
  }
  const skillWorkshopRevision = normalizeSkillWorkshopRevision(entry.skillWorkshopRevision);
  if (skillWorkshopRevision) {
    item.skillWorkshopRevision = skillWorkshopRevision;
  }
  return item;
}

function normalizeStoredSession(value: unknown): StoredComposerSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const draft = typeof entry.draft === "string" ? entry.draft : undefined;
  const queue = Array.isArray(entry.queue)
    ? entry.queue
        .slice(0, MAX_STORED_QUEUE_ITEMS)
        .map(normalizeQueueItem)
        .filter((item): item is ChatQueueItem => item !== null)
    : undefined;
  if (!draft && (!queue || queue.length === 0)) {
    return null;
  }
  return {
    ...(draft ? { draft } : {}),
    ...(queue && queue.length > 0 ? { queue } : {}),
    updatedAt:
      typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
        ? entry.updatedAt
        : Date.now(),
  };
}

export function loadChatComposerSnapshot(
  state: Pick<
    ChatComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello"
  >,
  sessionKey: string,
): { draft: string; queue: ChatQueueItem[] } | null {
  const storage = getSafeSessionStorage();
  if (!storage) {
    return null;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const storeSessionKey = storageSessionKeyForState(state, sessionKey);
    const session = normalizeStoredSession(readStore(storage, key).sessions[storeSessionKey]);
    if (!session) {
      return null;
    }
    return {
      draft: session.draft ?? "",
      queue: session.queue ?? [],
    };
  } catch {
    return null;
  }
}

export function persistChatComposerState(
  state: ChatComposerPersistenceState,
  sessionKey: string = state.sessionKey,
): void {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const storeSessionKey = storageSessionKeyForState(state, sessionKey);
    const draft = state.chatMessage;
    const queue = state.chatQueue
      .slice(0, MAX_STORED_QUEUE_ITEMS)
      .map(serializeQueueItem)
      .filter((item): item is ChatQueueItem => item !== null);
    if (!draft && queue.length === 0) {
      delete store.sessions[storeSessionKey];
    } else {
      store.sessions[storeSessionKey] = {
        ...(draft ? { draft } : {}),
        ...(queue.length > 0 ? { queue } : {}),
        updatedAt: Date.now(),
      };
    }
    writeStore(storage, key, store);
  } catch {
    // Best-effort only: quota and privacy-mode storage errors should not break chat.
  }
}

export function removeStoredChatComposerQueueItem(
  state: Pick<
    ChatComposerPersistenceState,
    "settings" | "assistantAgentId" | "agentsList" | "hello"
  >,
  sessionKey: string,
  id: string,
): void {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim() || !id.trim()) {
    return;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const storeSessionKey = storageSessionKeyForState(state, sessionKey);
    const session = normalizeStoredSession(store.sessions[storeSessionKey]);
    if (!session?.queue?.length) {
      return;
    }
    const queue = session.queue.filter((item) => item.id !== id);
    if (!session.draft && queue.length === 0) {
      delete store.sessions[storeSessionKey];
    } else {
      store.sessions[storeSessionKey] = {
        ...(session.draft ? { draft: session.draft } : {}),
        ...(queue.length ? { queue } : {}),
        updatedAt: Date.now(),
      };
    }
    writeStore(storage, key, store);
  } catch {
    // Best-effort only: queue persistence must not make cancellation fail.
  }
}

export function persistStoredChatComposerQueue(
  state: ChatComposerScope,
  sessionKey: string,
  queue: ChatQueueItem[],
): void {
  const storage = getSafeSessionStorage();
  if (!storage || !sessionKey.trim()) {
    return;
  }
  try {
    const key = storageKeyForGateway(state.settings?.gatewayUrl);
    const store = readStore(storage, key);
    const storeSessionKey = storageSessionKeyForState(state, sessionKey);
    const session = normalizeStoredSession(store.sessions[storeSessionKey]);
    const serializedQueue = queue
      .slice(0, MAX_STORED_QUEUE_ITEMS)
      .map(serializeQueueItem)
      .filter((item): item is ChatQueueItem => item !== null);
    if (!session?.draft && serializedQueue.length === 0) {
      delete store.sessions[storeSessionKey];
    } else {
      store.sessions[storeSessionKey] = {
        ...(session?.draft ? { draft: session.draft } : {}),
        ...(serializedQueue.length ? { queue: serializedQueue } : {}),
        updatedAt: Date.now(),
      };
    }
    writeStore(storage, key, store);
  } catch {
    // Best-effort only: queue persistence must not make send recovery fail.
  }
}

export function restoreChatComposerState(
  state: ChatComposerPersistenceState,
  options: RestoreOptions = {},
): boolean {
  const sessionKey = options.sessionKey ?? state.sessionKey;
  const snapshot = loadChatComposerSnapshot(state, sessionKey);
  if (!snapshot) {
    return false;
  }
  if (!options.preserveCurrent || !state.chatMessage) {
    state.chatMessage = snapshot.draft;
  }
  if ((!options.preserveCurrent && snapshot.queue.length > 0) || state.chatQueue.length === 0) {
    state.chatQueue = snapshot.queue;
  }
  return true;
}

export class ChatComposerPersistence {
  private timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private ready = false;
  private lastPersisted: {
    sessionKey: string;
    chatMessage: string;
    chatQueue: ChatQueueItem[];
  } | null = null;

  constructor(private readonly getState: () => ChatComposerPersistenceState | undefined) {}

  start() {
    const state = this.getState();
    if (!state) {
      return;
    }
    this.ready = true;
    this.lastPersisted = this.snapshot(state);
  }

  stop() {
    this.persistNow();
    this.ready = false;
    this.clearTimer();
  }

  restore(options: RestoreOptions = {}): boolean {
    const state = this.getState();
    if (!state) {
      return false;
    }
    const restored = restoreChatComposerState(state, options);
    this.lastPersisted = this.snapshot(state);
    return restored;
  }

  schedule() {
    this.persist(false);
  }

  persistNow() {
    this.persist(true);
  }

  persistChangedState() {
    const state = this.getState();
    if (this.lastPersisted?.chatQueue !== state?.chatQueue) {
      this.persistNow();
    }
  }

  private persist(immediate: boolean) {
    const state = this.getState();
    if (!this.ready || !state || this.isUnchanged(state)) {
      return;
    }
    this.clearTimer();
    if (!immediate) {
      this.timer = globalThis.setTimeout(
        () => this.persistNow(),
        CHAT_COMPOSER_DRAFT_PERSIST_DELAY_MS,
      );
      return;
    }
    persistChatComposerState(state);
    this.lastPersisted = this.snapshot(state);
  }

  private clearTimer() {
    if (this.timer === null) {
      return;
    }
    globalThis.clearTimeout(this.timer);
    this.timer = null;
  }

  private isUnchanged(state: ChatComposerPersistenceState): boolean {
    const last = this.lastPersisted;
    return Boolean(
      last &&
      last.sessionKey === state.sessionKey &&
      last.chatMessage === state.chatMessage &&
      last.chatQueue === state.chatQueue,
    );
  }

  private snapshot(state: ChatComposerPersistenceState) {
    return {
      sessionKey: state.sessionKey,
      chatMessage: state.chatMessage,
      chatQueue: state.chatQueue,
    };
  }
}
