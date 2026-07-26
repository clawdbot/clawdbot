import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { pathForRoute } from "../../app-route-paths.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import {
  acquireWorkboardSessionCardLookup,
  type WorkboardSessionCardLookupLease,
  type WorkboardSessionCardMatch,
} from "../../lib/workboard/session-card-lookup.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

class WorkboardCardChip extends OpenClawLightDomElement {
  @property({ attribute: false }) basePath = "";
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) sessionKey = "";

  @state() private match: WorkboardSessionCardMatch | null = null;
  private lease: (WorkboardSessionCardLookupLease & { client: GatewayBrowserClient }) | null = null;
  private observedSessionKey = "";
  private unsubscribe: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.synchronizeLookup();
  }

  override updated(): void {
    if (this.isConnected) {
      this.synchronizeLookup();
    }
  }

  override disconnectedCallback(): void {
    this.releaseLookup();
    super.disconnectedCallback();
  }

  private synchronizeLookup(): void {
    const client = this.client;
    const sessionKey = this.sessionKey.trim();
    if (!client || !sessionKey) {
      this.releaseLookup();
      return;
    }
    let lease = this.lease;
    if (lease?.client !== client) {
      this.releaseLookup();
      lease = { ...acquireWorkboardSessionCardLookup(client), client };
      this.lease = lease;
    }
    if (this.observedSessionKey === sessionKey) {
      return;
    }
    this.unsubscribe?.();
    this.observedSessionKey = sessionKey;
    this.match = null;
    this.unsubscribe = lease.subscribe(sessionKey, (match) => {
      if (this.lease === lease && this.observedSessionKey === sessionKey) {
        this.match = match;
      }
    });
  }

  private releaseLookup(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lease?.release();
    this.lease = null;
    this.observedSessionKey = "";
    this.match = null;
  }

  override render() {
    const match = this.match;
    if (!match) {
      return nothing;
    }
    const status = t(`workboard.status.${match.status}`);
    const href = `${pathForRoute("workboard", this.basePath)}?${new URLSearchParams({
      board: match.boardId,
    })}`;
    return html`
      <a
        class="board-session-surface__workboard-chip"
        href=${href}
        aria-label=${t("chat.board.workboardCard", { title: match.title, status })}
      >
        ${icons.kanban}
        <span class="board-session-surface__workboard-title">${match.title}</span>
        <span class="board-session-surface__workboard-status">${status}</span>
      </a>
    `;
  }
}

if (!customElements.get("openclaw-workboard-card-chip")) {
  customElements.define("openclaw-workboard-card-chip", WorkboardCardChip);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-workboard-card-chip": WorkboardCardChip;
  }
}
