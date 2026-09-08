import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { renderCompactAttachmentCard } from "./chat-attachment-card.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
const TEXT_PREVIEW_TIMEOUT_MS = 10_000;

export function isTextAttachment(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith("text/")) {
    return true;
  }
  if (
    /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|x-javascript|yaml|x-yaml)$/.test(
      mimeType,
    )
  ) {
    return true;
  }
  return (
    (!mimeType || mimeType === "application/octet-stream") &&
    /\.(?:txt|md|markdown|log|csv|tsv|json|jsonl|xml|yaml|yml)$/i.test(filename)
  );
}

class ChatTextAttachment extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;

  @state() private text: string | null = null;
  @state() private failed = false;

  private loadVersion = 0;
  private abortController: AbortController | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate("src");
  }

  override disconnectedCallback(): void {
    this.cancelLoad();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("src") || changed.has("sourceIdentity") || changed.has("sizeBytes")) {
      this.cancelLoad();
      this.text = null;
      this.failed = false;
      void this.loadText();
    }
  }

  private cancelLoad(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async loadText(): Promise<void> {
    if (this.sizeBytes !== undefined && this.sizeBytes > TEXT_PREVIEW_MAX_BYTES) {
      this.failed = true;
      return;
    }
    const version = this.loadVersion;
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = setTimeout(() => controller.abort(), TEXT_PREVIEW_TIMEOUT_MS);
    try {
      // The caller supplies a resolved media ticket or blob, never a reusable credential.
      const response = await fetch(this.src, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Text attachment unavailable");
      }
      const bytes = await readResponseBytesWithinLimit(response, TEXT_PREVIEW_MAX_BYTES);
      if (!bytes) {
        throw new Error("Text attachment exceeds preview limit");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) {
        throw new Error("Binary attachment");
      }
      if (version === this.loadVersion && this.isConnected) {
        this.text = text;
      }
    } catch {
      if (version === this.loadVersion && this.isConnected) {
        this.failed = true;
      }
    } finally {
      clearTimeout(timeout);
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  override render() {
    return html`
      ${renderCompactAttachmentCard({
        kind: "document",
        label: this.label,
        mimeType: this.mimeType,
        sizeBytes: this.sizeBytes,
        downloadHref: this.src,
      })}
      ${
        this.failed
          ? html`<p class="muted" role="status">${t("chat.attachments.textPreviewUnavailable")}</p>`
          : this.text === null
            ? html`<p class="muted" role="status">${t("common.loading")}</p>`
            : html`<pre
                class="sidebar-attachment-preview__text"
                tabindex="0"
                aria-label=${this.label}
              >
${this.text}</pre>`
      }
    `;
  }
}

if (!customElements.get("openclaw-chat-text-attachment")) {
  customElements.define("openclaw-chat-text-attachment", ChatTextAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-text-attachment": ChatTextAttachment;
  }
}
