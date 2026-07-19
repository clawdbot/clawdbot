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
type AvatarFetch = { authToken: string; controller: AbortController };

/** Bound local avatar fetches so a stalled Control UI media route cannot pin pending state forever. */
const AGENT_SELECT_AVATAR_FETCH_TIMEOUT_MS = 30_000;
export class AgentSelect extends OpenClawLightDomElement {
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  @property({ attribute: false }) selectedId: string | null = null;
  @property({ attribute: false }) defaultId: string | null = null;
  @property({ attribute: false }) identityById: Record<string, AgentIdentityResult> = {};
  @property({ attribute: false }) authToken: string | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) onSelect: (agentId: string) => void = () => {};
  @property({ attribute: false }) onCreateAgent: () => void = () => {};

  private readonly avatarBlobUrlByRoute = new Map<string, string>();
  private readonly avatarFetchByRoute = new Map<string, AvatarFetch>();

  override disconnectedCallback() {
    this.resetAvatarState();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>) {
    // Cached blobs and failures belong to the credential that fetched them;
    // a rotated token must refetch with the current authorization.
    if (changed.has("authToken")) {
      this.resetAvatarState();
    }
  }

  private resetAvatarState() {
    for (const request of this.avatarFetchByRoute.values()) {
      request.controller.abort();
    }
    for (const blobUrl of this.avatarBlobUrlByRoute.values()) {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    }
    this.avatarBlobUrlByRoute.clear();
    this.avatarFetchByRoute.clear();
  }

  private ensureLocalAvatar(url: string, authToken: string) {
    if (this.avatarFetchByRoute.has(url)) {
      return;
    }
    const request: AvatarFetch = { authToken, controller: new AbortController() };
    this.avatarFetchByRoute.set(url, request);
    void this.fetchLocalAvatarBlobUrl(url, request).then((blobUrl) => {
      // Rotation can start a replacement before the aborted request settles.
      // Only the request still owning this route may clear or cache its state.
      if (this.avatarFetchByRoute.get(url) !== request) {
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
        }
        return;
      }
      if (!this.isConnected || this.authToken !== authToken) {
        this.avatarFetchByRoute.delete(url);
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
        }
        return;
      }
      // Cache the result (including empty miss) before clearing pending so a
      // concurrent re-render cannot start a second unbounded fetch for the same URL.
      this.avatarBlobUrlByRoute.set(url, blobUrl);
      this.avatarFetchByRoute.delete(url);
      if (blobUrl) {
        this.requestUpdate();
      }
    });
  }

  private async fetchLocalAvatarBlobUrl(url: string, request: AvatarFetch): Promise<string> {
    const timeout = setTimeout(
      () =>
        request.controller.abort(new DOMException("agent avatar fetch timed out", "TimeoutError")),
      AGENT_SELECT_AVATAR_FETCH_TIMEOUT_MS,
    );
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${request.authToken}` },
        signal: request.controller.signal,
      });
      if (!res.ok) {
        return "";
      }
      return URL.createObjectURL(await res.blob());
    } catch {
      // Timeouts and transport failures share the empty-string miss path so the
      // picker keeps the text fallback instead of leaving avatarRoutesPending set.
      return "";
    } finally {
      clearTimeout(timeout);
    }
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
    if (item.hasAttribute("data-create-agent")) {
      this.onCreateAgent();
      return;
    }
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
    const unavailable = this.disabled;

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
        <div class="agent-select__separator" role="separator"></div>
        <wa-dropdown-item class="agent-select__option" data-create-agent>
          <span slot="icon">${icons.users}</span>
          <span class="agent-select__option-label">${t("custodian.newAgent")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    `;
  }
}
