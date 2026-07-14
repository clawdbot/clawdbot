import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
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

export class AgentSelect extends OpenClawLightDomElement {
  @property({ attribute: false }) agents: GatewayAgentRow[] = [];
  @property({ attribute: false }) selectedId: string | null = null;
  @property({ attribute: false }) defaultId: string | null = null;
  @property({ attribute: false }) identityById: Record<string, AgentIdentityResult> = {};
  @property({ attribute: false }) authToken: string | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) onSelect: (agentId: string) => void = () => {};

  @state() private open = false;

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
  }

  override disconnectedCallback() {
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
    clearTimeout(this.typeaheadResetTimer);
    this.releaseAvatarBlobUrls();
    super.disconnectedCallback();
  }

  // Local /avatar/<id> routes require the bearer credential when gateway auth
  // is active and <img> cannot send headers, so fetch them and render blob
  // URLs (same single-credential contract as chat-avatar.ts). "" marks a
  // failed fetch so we do not retry every render.
  private readonly avatarBlobUrlByRoute = new Map<string, string>();
  private readonly avatarRoutesPending = new Set<string>();

  protected override willUpdate(changed: PropertyValues<this>) {
    // Cached blobs and failures belong to the credential that fetched them;
    // a rotated token (e.g. device token after reconnect) must refetch.
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
        // Drop stale results: the element may be gone or the credential may
        // have rotated while this request was in flight.
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

  // Owns the open transition: focus must move into the listbox only after the
  // options exist in the DOM, so wait for the post-toggle render.
  private setOpen(next: boolean) {
    if (this.open === next) {
      return;
    }
    this.open = next;
    if (next) {
      void this.updateComplete.then(() => this.focusSelectedOption());
      return;
    }
    clearTimeout(this.typeaheadResetTimer);
    this.typeaheadQuery = "";
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    if (!this.open || event.composedPath().includes(this)) {
      return;
    }
    this.setOpen(false);
  };

  private readonly handleTriggerKeydown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    this.setOpen(true);
  };

  private readonly handleListboxKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.setOpen(false);
      this.trigger()?.focus();
      return;
    }
    if (event.key === "Tab") {
      // Options are tabindex=-1, so hand focus back to the trigger before the
      // default Tab moves on; otherwise the list unmounts under the focused
      // option and focus falls to <body>.
      this.setOpen(false);
      this.trigger()?.focus();
      return;
    }
    if (event.key === " ") {
      // Space activates the focused option button natively.
      return;
    }
    if (
      event.key.length === 1 &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      this.focusTypeaheadOption(event.key);
      return;
    }

    const options = this.options();
    if (options.length === 0) {
      return;
    }
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;
    if (event.key === "ArrowDown") {
      nextIndex = Math.min(currentIndex + 1, options.length - 1);
    } else if (event.key === "ArrowUp") {
      nextIndex = Math.max(currentIndex - 1, 0);
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = options.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    options[nextIndex]?.focus();
  };

  // Buffered printable-key search, matching the native <select> type-ahead:
  // repeating one letter cycles its matches, mixed letters accumulate a prefix.
  private typeaheadQuery = "";
  private typeaheadResetTimer: ReturnType<typeof setTimeout> | undefined;

  private focusTypeaheadOption(key: string) {
    clearTimeout(this.typeaheadResetTimer);
    const normalizedKey = key.toLocaleLowerCase();
    const accumulated = `${this.typeaheadQuery}${normalizedKey}`;
    this.typeaheadQuery =
      accumulated === normalizedKey.repeat(accumulated.length) ? normalizedKey : accumulated;
    this.typeaheadResetTimer = setTimeout(() => {
      this.typeaheadQuery = "";
    }, 500);

    const options = this.options();
    const activeIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    const ordered = [...options.slice(activeIndex + 1), ...options.slice(0, activeIndex + 1)];
    const match = ordered.find((option) =>
      option
        .querySelector(".agent-select__option-label")
        ?.textContent?.trim()
        .toLocaleLowerCase()
        .startsWith(this.typeaheadQuery),
    );
    match?.focus();
  }

  private options() {
    return Array.from(this.querySelectorAll<HTMLButtonElement>(".agent-select__option"));
  }

  private trigger() {
    return this.querySelector<HTMLButtonElement>(".agent-select__trigger");
  }

  private focusSelectedOption() {
    const selected = this.querySelector<HTMLButtonElement>(
      '.agent-select__option[aria-selected="true"]',
    );
    (selected ?? this.querySelector<HTMLButtonElement>(".agent-select__option"))?.focus();
  }

  private readonly toggle = () => {
    if (this.disabled || this.agents.length === 0) {
      return;
    }
    this.setOpen(!this.open);
  };

  private choose(agentId: string) {
    this.setOpen(false);
    this.trigger()?.focus();
    if (agentId !== this.selectedId) {
      this.onSelect(agentId);
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

  override render() {
    const selectedAgent =
      this.agents.find((agent) => agent.id === this.selectedId) ??
      this.agents.find((agent) => agent.id === this.defaultId) ??
      this.agents[0];
    const selectedBadge = selectedAgent ? agentBadgeText(selectedAgent.id, this.defaultId) : null;

    return html`
      <div class="agent-select">
        <button
          type="button"
          class="agent-select__trigger"
          aria-haspopup="listbox"
          aria-expanded=${String(this.open)}
          ?disabled=${this.disabled || this.agents.length === 0}
          @click=${this.toggle}
          @keydown=${this.handleTriggerKeydown}
        >
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
        ${this.open
          ? html`
              <div
                class="agent-select__list"
                role="listbox"
                aria-label=${t("agents.selectTitle")}
                @keydown=${this.handleListboxKeydown}
              >
                ${this.agents.map((agent) => {
                  const badge = agentBadgeText(agent.id, this.defaultId);
                  const selected = agent.id === this.selectedId;
                  return html`
                    <button
                      type="button"
                      class="agent-select__option"
                      role="option"
                      aria-selected=${String(selected)}
                      data-agent-id=${agent.id}
                      tabindex="-1"
                      @click=${() => this.choose(agent.id)}
                    >
                      ${this.renderAvatar(agent)}
                      <span class="agent-select__option-label">${normalizeAgentLabel(agent)}</span>
                      ${badge ? html`<span class="agent-select__badge">${badge}</span>` : nothing}
                      ${selected
                        ? html`<span class="agent-select__check" aria-hidden="true"
                            >${icons.check}</span
                          >`
                        : nothing}
                    </button>
                  `;
                })}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}
