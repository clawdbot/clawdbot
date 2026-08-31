import { html, LitElement, nothing, type PropertyValues } from "lit";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { DurableComposerRecoveryEntry } from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
  type ChatOutboxRecoveryEntry,
} from "../../lib/chat/outbox-recovery.ts";
import {
  resolveStoredChatOutboxScope,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

const draftStore = import("../../lib/chat/composer-draft-store.runtime.ts");

/** Recovery is owner-scoped and intentionally outside every automatic drain. */
class ChatOutboxRecovery extends LitElement {
  static override properties = { host: { attribute: false }, identity: { type: String } };
  host?: ChatPageHost;
  identity = "";
  private entries: ChatOutboxRecoveryEntry[] = [];
  private drafts: DurableComposerRecoveryEntry[] = [];
  private error = "";
  private busy = false;
  private generation = 0;
  private unsubscribe?: () => void;

  override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = subscribeStoredChatOutboxChanges(() => void this.refresh());
  }
  override disconnectedCallback() {
    this.generation++;
    this.unsubscribe?.();
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("identity") || changed.has("host")) {
      void this.refresh();
    }
  }
  private owner() {
    const host = this.host;
    if (
      !host?.connected ||
      host.selectedChatSessionIncognito ||
      !host.client?.recoveryScopeReady ||
      !host.client.recoveryScope
    ) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(host.settings.gatewayUrl).gatewayOwner,
      recoveryScope: host.client.recoveryScope,
    };
  }
  private async refresh() {
    const generation = ++this.generation;
    const host = this.host;
    const owner = this.owner();
    this.drafts = [];
    try {
      const recovery = host ? readChatOutboxRecovery(host) : null;
      this.entries = recovery?.entries ?? [];
      this.error = recovery?.blocked ? t("chat.outboxRecoveryFull") : "";
      if (owner) {
        const result = await (await draftStore).prepareDurableComposerRecovery(owner);
        if (generation !== this.generation || !this.isConnected) {
          return;
        }
        if (result.status === "storage-failed") {
          throw new Error("storage-failed");
        }
        this.drafts = result.entries;
      }
    } catch {
      this.error = t("chat.outboxRecoveryStorageFailed");
    }
    this.requestUpdate();
  }
  private async recover(entry: ChatOutboxRecoveryEntry | DurableComposerRecoveryEntry) {
    const host = this.host;
    const owner = this.owner();
    if (!host || !owner || this.busy) {
      return;
    }
    const identity = this.identity;
    const client = host.client;
    const sessionId = host.currentSessionId;
    const connectionEpoch = host.connectionEpoch;
    const isCurrent = () =>
      this.isConnected &&
      this.host === host &&
      this.identity === identity &&
      host.client === client &&
      host.currentSessionId === sessionId &&
      host.connectionEpoch === connectionEpoch &&
      JSON.stringify(this.owner()) === JSON.stringify(owner) &&
      !host.chatMessage &&
      !host.chatGoalDraftMode &&
      !host.chatAttachments.length &&
      !host.chatQueue.length;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
      if (!isCurrent()) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const scope = resolveStoredChatOutboxScope(host, host.sessionKey);
      const destination = captureChatOutboxRecoveryDestination(host, scope);
      const durableScope = { ...owner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` };
      const store = await draftStore;
      const before = await store.readDurableComposerDraft(durableScope);
      if (before.status === "storage-failed") {
        this.error = t("chat.outboxRecoveryStorageFailed");
        return;
      }
      if (!destination || before.status === "found" || !isCurrent()) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const confirmed = await showConfirmDialog({
        title: t("chat.outboxRecoveryTitle"),
        message: t("chat.outboxRecoveryConfirm"),
        details: `${scope.sessionKey}${scope.agentId ? ` (${scope.agentId})` : ""}`,
        confirmLabel: t("chat.outboxRecoveryRestore"),
      });
      if (!confirmed || !isCurrent()) {
        return;
      }
      const currentDraft = await store.readDurableComposerDraft(durableScope);
      if (!isCurrent() || JSON.stringify(currentDraft) !== JSON.stringify(before)) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const result =
        "id" in entry
          ? restoreChatOutboxRecovery(host, entry, destination, before.revision ?? 0)
          : (
              await store.restoreDurableComposerRecovery(
                durableScope,
                entry,
                before.revision ?? 0,
                before.writeId,
                () =>
                  isCurrent() &&
                  JSON.stringify(captureChatOutboxRecoveryDestination(host, scope)) ===
                    JSON.stringify(destination),
                destination.revision,
              )
            ).status;
      if (result === "restored" || result === "persisted") {
        if (this.host === host && this.identity === identity) {
          this.dispatchEvent(new CustomEvent("outbox-restored", { bubbles: true }));
        }
        await this.refresh();
      } else {
        this.error = t(
          result === "conflict"
            ? "chat.outboxRecoveryConflict"
            : "chat.outboxRecoveryStorageFailed",
        );
      }
    } catch {
      this.error = t("chat.outboxRecoveryStorageFailed");
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }
  protected override render() {
    if (!this.entries.length && !this.drafts.length && !this.error) {
      return nothing;
    }
    const rows = [...this.entries, ...this.drafts];
    return html`<details
      class="callout warn chat-outbox-recovery"
      style="max-height: 40vh; overflow: auto"
    >
      <summary>${t("chat.outboxRecoveryTitle")} (${rows.length})</summary>
      <p>${t("chat.outboxRecoveryDescription")}</p>
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
      ${rows.map(
        (entry) => html`<div class="chat-outbox-recovery-row">
          <p>
            ${"id" in entry
              ? [entry.session.draft, ...(entry.session.queue ?? []).map((item) => item.text)]
                  .filter(Boolean)
                  .join(" · ")
                  .slice(0, 240)
              : entry.text.slice(0, 240)}
          </p>
          <p>
            ${"id" in entry
              ? t("chat.outboxRecoveryMessages", {
                  count: String(entry.session.queue?.length ?? 0),
                })
              : entry.attachmentNames.join(", ").slice(0, 240)}
          </p>
          <button
            class="btn"
            ?disabled=${this.busy || !this.owner()}
            @click=${() => void this.recover(entry)}
          >
            ${t("chat.outboxRecoveryRestore")}
          </button>
        </div>`,
      )}
    </details>`;
  }
}
customElements.define("openclaw-chat-outbox-recovery", ChatOutboxRecovery);
