import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type { PropertyValues } from "lit";
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import {
  agentBadgeText,
  normalizeAgentLabel,
  resolveAgentTextAvatar,
} from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";

type WebAwesomeSelectEvent = Event & { detail: { item: Element } };

export class AgentSelect extends OpenClawLightDomElement {
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  @property({ attribute: false }) selectedId: string | null = null;
  @property({ attribute: false }) defaultId: string | null = null;
  @property({ attribute: false }) identityById: Record<string, AgentIdentityResult> = {};
  @property({ attribute: false }) authToken: string | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) onSelect: (agentId: string) => void = () => {};

  private readonly avatarBlobUrlByRoute = new Map<string, string>();
  private readonly avatarRoutesPending = new Set<string>();

  override disconnectedCallback() {
    this.releaseAvatarBlobUrls();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    // Cached blobs and failures belong to the credential that fetched them;
    // a rotated token must refetch with the current authorization.
    if (changed.has("authToken")) {
      this.releaseAvatarBlobUrls();
    }
  }

  private releaseAvatarBlobUrls() {
    for (const blobUrl of this.avatarBlobUrlByRoute.values()) {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    }
    this.avatarBlobUrlByRoute.clear();
    this.avatarRoutesPending.clear();
  }

  private ensureLocalAvatar(url: string, authToken: string) {
    if (this.avatarRoutesPending.has(url)) {
      return;
    }
    this.avatarRoutesPending.add(url);
    void fetch(url, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : ""))
      .catch(() => "")
      .then((blobUrl) => {
        this.avatarRoutesPending.delete(url);
        if (!this.isConnected || this.authToken !== authToken) {
          if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
          }
          return;
        }
        this.avatarBlobUrlByRoute.set(url, blobUrl);
        if (blobUrl) {
          this.requestUpdate();
        }
      });
  }

  private renderAvatar(agent: GatewayAgentRow) {
    const identity = this.identityById[agent.id] ?? null;
    const url = resolveAgentAvatarUrl(agent, identity);
    const imageUrl = url ? this.resolveRenderableAvatarUrl(url) : null;
    if (imageUrl) {
      return html`<img class="agent-select__avatar" src=${imageUrl} alt="" loading="lazy" />`;
    }
    const text = resolveAgentTextAvatar(agent, identity);
    const fallback = (normalizeAgentLabel(agent)[0] ?? "?").toUpperCase();
    return html`
      <span class="agent-select__avatar agent-select__avatar--text" aria-hidden="true"
        >${text ?? fallback}</span
      >
    `;
  }

  private resolveRenderableAvatarUrl(url: string): string | null {
    if (!this.authToken || !url.startsWith("/")) {
      return url;
    }
    const cached = this.avatarBlobUrlByRoute.get(url);
    if (cached !== undefined) {
      return cached || null;
    }
    this.ensureLocalAvatar(url, this.authToken);
    return null;
  }

  private readonly handleSelect = (event: WebAwesomeSelectEvent) => {
    const item = event.detail.item as HTMLElement & { checked?: boolean; value?: string };
    const agentId = item.value ?? item.getAttribute("value");
    if (!agentId) {
      return;
    }
    if (agentId === this.selectedId) {
      event.preventDefault();
      item.checked = true;
      const dropdown = event.currentTarget as HTMLElement & { open: boolean };
      dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
      dropdown.open = false;
      return;
    }
    this.onSelect(agentId);
  };

  override render() {
    const selectedAgent =
      this.agents.find((agent) => agent.id === this.selectedId) ??
      this.agents.find((agent) => agent.id === this.defaultId) ??
      this.agents[0];
    const selectedBadge = selectedAgent ? agentBadgeText(selectedAgent.id, this.defaultId) : null;
    const unavailable = this.disabled || this.agents.length === 0;

    return html`
      <wa-dropdown class="agent-select" placement="bottom-start" @wa-select=${this.handleSelect}>
        <button slot="trigger" type="button" class="agent-select__trigger" ?disabled=${unavailable}>
          ${selectedAgent
            ? html`
                ${this.renderAvatar(selectedAgent)}
                <span class="agent-select__label">${normalizeAgentLabel(selectedAgent)}</span>
                ${selectedBadge
                  ? html`<span class="agent-select__badge">${selectedBadge}</span>`
                  : nothing}
              `
            : html`<span class="agent-select__label">${t("agents.noAgents")}</span>`}
          <span class="agent-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </button>
        ${this.agents.map((agent) => {
          const badge = agentBadgeText(agent.id, this.defaultId);
          const selected = agent.id === this.selectedId;
          return html`
            <wa-dropdown-item
              class="agent-select__option"
              data-agent-id=${agent.id}
              .value=${agent.id}
              type="checkbox"
              .checked=${selected}
            >
              <span slot="icon">${this.renderAvatar(agent)}</span>
              <span class="agent-select__option-label">${normalizeAgentLabel(agent)}</span>
              ${badge
                ? html`<span slot="details" class="agent-select__badge">${badge}</span>`
                : nothing}
            </wa-dropdown-item>
          `;
        })}
      </wa-dropdown>
    `;
  }
}
