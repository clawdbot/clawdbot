import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  UsersPrefsGetResult,
  UsersPrefsSetResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { registerBookmarksEnglish } from "../../i18n/locales/en-bookmarks.ts";
import { visibleChatHistoryMessages } from "../../lib/chat/message-visibility.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { persistedMessageEntryId, readChatThreadMessageIdentity } from "./chat-thread-items.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";

registerBookmarksEnglish();

export type ChatBookmark = {
  id: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  messageId: string;
  name: string;
};
export type ChatBookmarkHistory = {
  bookmark: ChatBookmark;
  showContext: boolean;
  updateMedia: () => void;
  result:
    | { status: "loading" }
    | { status: "loaded"; messages: unknown[] }
    | { status: "error"; message: string };
};
export type ChatBookmarkScope = {
  client: GatewayBrowserClient;
  generation: number;
  profileId: string;
  agentId: string;
  key: string;
  sessionId: string;
  canWrite: boolean;
  isCurrent: () => boolean;
};
export type ChatBookmarkAccess = {
  revision: number;
  bookmarks: readonly ChatBookmark[];
  selectedId: string | null;
  toggle?: (messageId: string) => void;
  edit?: (messageId: string) => void;
  open: (bookmark: ChatBookmark) => void;
};
const PREFIX = "chat.bookmark:";
const fold = (value: string) => value.normalize("NFC").toLowerCase().normalize("NFC");

function readBookmark(id: string, value: unknown): ChatBookmark | null {
  const row = asNullableRecord(value);
  if (
    !id.startsWith(PREFIX) ||
    !row ||
    typeof row.agentId !== "string" ||
    !row.agentId.trim() ||
    typeof row.sessionKey !== "string" ||
    !row.sessionKey.trim() ||
    typeof row.sessionId !== "string" ||
    !row.sessionId.trim() ||
    typeof row.messageId !== "string" ||
    !row.messageId.trim() ||
    typeof row.name !== "string" ||
    !row.name.trim() ||
    row.name.includes("\0") ||
    Array.from(row.name).length > 70
  ) {
    return null;
  }
  return {
    id,
    agentId: row.agentId,
    sessionKey: row.sessionKey,
    sessionId: row.sessionId,
    messageId: row.messageId,
    name: row.name,
  };
}

/** Each favorite is one existing preference key; unrelated concurrent edits cannot overwrite it. */
export class ChatBookmarks {
  scope: ChatBookmarkScope | null = null;
  bookmarks: ChatBookmark[] = [];
  revision = 0;
  query = "";
  allConversations = false;
  loading = false;
  indexReady = false;
  saving = false;
  error: string | null = null;
  open = false;
  editor: { messageId: string; bookmark?: ChatBookmark; name: string } | null = null;
  selectedId: string | null = null;
  history: ChatBookmarkHistory | null = null;
  private loadAttempt = 0;

  constructor(private readonly update: () => void) {}

  bind(scope: ChatBookmarkScope | null): void {
    const previous = this.scope;
    if (
      previous &&
      scope &&
      previous.client === scope.client &&
      previous.generation === scope.generation &&
      previous.profileId === scope.profileId &&
      previous.agentId === scope.agentId &&
      previous.key === scope.key &&
      previous.sessionId === scope.sessionId &&
      previous.canWrite === scope.canWrite &&
      previous.isCurrent()
    ) {
      return;
    }
    if (!previous && !scope) {
      return;
    }
    this.clearHistory();
    this.scope = scope;
    this.loadAttempt++;
    this.bookmarks = [];
    this.query = "";
    this.allConversations = false;
    this.loading = this.indexReady = this.saving = this.open = false;
    this.error = this.editor = this.selectedId = null;
    this.revision++;
    if (scope) {
      void this.refreshIndex();
    }
  }

  private current(scope: ChatBookmarkScope): boolean {
    return this.scope === scope && scope.isCurrent();
  }

  get conversationBookmarks(): ChatBookmark[] {
    return this.bookmarks.filter(
      (item) => item.agentId === this.scope?.agentId && item.sessionKey === this.scope?.key,
    );
  }

  canOpen(bookmark: ChatBookmark): boolean {
    return bookmark.agentId === this.scope?.agentId && bookmark.sessionKey === this.scope?.key;
  }

  get results(): ChatBookmark[] {
    const query = fold(this.query.trim());
    const bookmarks = this.allConversations ? this.bookmarks : this.conversationBookmarks;
    return bookmarks.filter((bookmark) => fold(bookmark.name).includes(query));
  }

  async refreshIndex(): Promise<void> {
    const scope = this.scope;
    if (!scope || !this.current(scope)) {
      return;
    }
    const attempt = ++this.loadAttempt;
    this.loading = true;
    this.error = null;
    this.update();
    try {
      const result = await scope.client.request<UsersPrefsGetResult>("users.prefs.get", {});
      if (!this.current(scope) || attempt !== this.loadAttempt) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(t("chat.bookmarks.storageUnavailable"));
      }
      this.bookmarks = Object.entries(result.entries)
        .flatMap(([id, value]) => {
          const bookmark = readBookmark(id, value);
          return bookmark ? [bookmark] : [];
        })
        .toSorted((a, b) => a.name.localeCompare(b.name));
      this.indexReady = true;
      this.revision++;
    } catch (error) {
      if (this.current(scope) && attempt === this.loadAttempt) {
        this.error = formatUiError(error);
        this.indexReady = false;
      }
    } finally {
      if (this.current(scope) && attempt === this.loadAttempt) {
        this.loading = false;
        this.update();
      }
    }
  }

  show(): void {
    this.clearHistory();
    this.open = true;
    this.editor = null;
    this.query = "";
    this.allConversations = false;
    void this.refreshIndex();
  }

  private clearHistory(): void {
    releaseChatMediaResourceSubscriber(this.history?.updateMedia);
    this.history = null;
  }

  close(): void {
    this.clearHistory();
    this.editor = null;
    this.open = false;
    this.update();
  }

  backToList(): void {
    this.clearHistory();
    this.update();
  }

  async showHistory(bookmark: ChatBookmark): Promise<void> {
    const scope = this.scope;
    if (
      !scope ||
      !this.current(scope) ||
      !this.canOpen(bookmark) ||
      bookmark.sessionId === scope.sessionId
    ) {
      return;
    }
    this.clearHistory();
    this.editor = null;
    this.error = null;
    this.open = true;
    const current = () => this.current(scope) && this.open && this.history === history;
    const history: ChatBookmarkHistory = {
      bookmark: { ...bookmark },
      showContext: false,
      updateMedia: () => {
        if (current()) {
          this.update();
        }
      },
      result: { status: "loading" },
    };
    this.history = history;
    this.update();
    try {
      const result = await scope.client.request<ChatHistoryResult>("chat.history", {
        agentId: bookmark.agentId,
        sessionKey: bookmark.sessionKey,
        sessionId: bookmark.sessionId,
        messageId: bookmark.messageId,
        limit: 5,
        maxChars: 50_000,
        maxBytes: 128_000,
      });
      if (!current()) {
        return;
      }
      const messages = visibleChatHistoryMessages(result.messages).filter((message) => {
        const role = readChatThreadMessageIdentity(message)?.role;
        return role === "user" || role === "assistant";
      });
      // sessionInfo describes the live chat; only the top-level ID owns this archived read.
      if (
        result.sessionId !== history.bookmark.sessionId ||
        !messages.some((message) => persistedMessageEntryId(message) === history.bookmark.messageId)
      ) {
        throw new Error(t("chat.bookmarks.historyUnavailable"));
      }
      history.result = { status: "loaded", messages };
    } catch (error) {
      if (current()) {
        history.result = { status: "error", message: formatUiError(error) };
      }
    } finally {
      if (current()) {
        this.update();
      }
    }
  }

  toggle(messageId: string): void {
    const saved = this.conversationBookmarks.find(
      (item) => item.messageId === messageId && item.sessionId === this.scope?.sessionId,
    );
    if (saved) {
      void this.remove(saved);
    } else {
      this.edit(messageId);
    }
  }

  edit(messageId: string, bookmark?: ChatBookmark): void {
    if (!this.scope?.canWrite || !this.current(this.scope) || !this.indexReady) {
      return;
    }
    const saved =
      bookmark ??
      this.conversationBookmarks.find(
        (item) => item.messageId === messageId && item.sessionId === this.scope?.sessionId,
      );
    this.clearHistory();
    this.editor = { messageId, bookmark: saved, name: saved?.name ?? "" };
    this.open = true;
    this.error = null;
    this.update();
  }

  async save(): Promise<void> {
    const editor = this.editor;
    const name = editor?.name.trim() ?? "";
    if (editor && name && !name.includes("\0") && Array.from(name).length <= 70) {
      await this.write(editor.messageId, name, editor.bookmark);
    }
  }

  async remove(bookmark: ChatBookmark): Promise<void> {
    await this.write(bookmark.messageId, null, bookmark);
  }

  private async write(
    messageId: string,
    name: string | null,
    bookmark?: ChatBookmark,
  ): Promise<void> {
    const scope = this.scope;
    if (!scope?.canWrite || !this.current(scope) || !this.indexReady || this.saving) {
      return;
    }
    const editing = this.editor;
    this.saving = true;
    this.error = null;
    this.update();
    try {
      let id = bookmark?.id;
      if (!id) {
        const source = JSON.stringify([scope.agentId, scope.key, scope.sessionId, messageId]);
        id = PREFIX + bytesToHex(sha256(new TextEncoder().encode(source)));
      }
      const source = bookmark ?? {
        agentId: scope.agentId,
        sessionKey: scope.key,
        sessionId: scope.sessionId,
        messageId,
      };
      const value =
        name === null
          ? null
          : {
              agentId: source.agentId,
              sessionKey: source.sessionKey,
              sessionId: source.sessionId,
              messageId: source.messageId,
              name,
            };
      const result = await scope.client.request<UsersPrefsSetResult>("users.prefs.set", {
        entries: { [id]: value },
      });
      if (!this.current(scope)) {
        return;
      }
      if (result.status !== "ok") {
        throw new Error(t("chat.bookmarks.storageUnavailable"));
      }
      await this.refreshIndex();
      if (this.current(scope) && editing && this.editor === editing && !this.error) {
        this.close();
      }
    } catch (error) {
      if (this.current(scope)) {
        this.error = formatUiError(error);
        this.open = true;
      }
    } finally {
      if (this.current(scope)) {
        this.saving = false;
        this.update();
      }
    }
  }
}
