import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import type { PropertyValues } from "lit";
import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { AgentIdentityResult, GatewayAgentRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { resolveAgentTextAvatar } from "../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { icons } from "./icons.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

export type AgentSelectOption = {
  value: string;
  label: string;
  agent?: GatewayAgentRow;
  icon?: TemplateResult;
  description?: string;
  badge?: string;
  disabled?: boolean;
};

type WebAwesomeSelectEvent = Event & { detail: { item: Element } };
type AvatarFetch = { authToken: string; controller: AbortController };

/** Bound local avatar fetches so a stalled Control UI media route cannot pin pending state forever. */
const AGENT_SELECT_AVATAR_FETCH_TIMEOUT_MS = 30_000;

export function renderAgentSelectAvatar(
  option: AgentSelectOption,
  identity: AgentIdentityResult | null = null,
  imageUrl?: string | null,
) {
  const resolvedImageUrl =
    imageUrl === undefined && option.agent
      ? resolveAgentAvatarUrl(option.agent, identity)
      : (imageUrl ?? null);
  if (resolvedImageUrl) {
    return html`<img class="agent-select__avatar" src=${resolvedImageUrl} alt="" loading="lazy" />`;
  }
  if (option.icon) {
    return html`<span class="agent-select__avatar agent-select__avatar--icon" aria-hidden="true"
      >${option.icon}</span
    >`;
  }
  const text = option.agent ? resolveAgentTextAvatar(option.agent, identity) : null;
  const fallback = (option.label[0] ?? "?").toUpperCase();
  return html`
    <span
      class="agent-select__avatar agent-select__avatar--text"
      data-avatar=${text ?? fallback}
      aria-hidden="true"
    ></span>
  `;
}

export function renderAgentSelectCopy(option: AgentSelectOption) {
  return html`
    <span class="agent-select__option-copy">
      <span class="agent-select__option-label">${option.label}</span>
      ${option.description
        ? html`<span class="agent-select__option-description">${option.description}</span>`
        : nothing}
    </span>
  `;
}

export class AgentSelect extends OpenClawLightDomElement {
  @property({ attribute: false }) options: readonly AgentSelectOption[] = [];
  @property({ attribute: false }) value = "";
  @property({ attribute: false }) placeholder = "";
  @property({ attribute: false }) accessibleLabel = "";
  @property({ attribute: false }) identityById: Record<string, AgentIdentityResult> = {};
  @property({ attribute: false }) authToken: string | null = null;
  @property({ attribute: false }) disabled = false;
  @property({ attribute: false }) onSelect: (value: string) => void = () => {};
  @property({ attribute: false }) onCreateAgent: (() => void) | null = null;

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
    if (changed.has("disabled") && this.disabled) {
      const dropdown = this.querySelector<HTMLElement & { open: boolean }>("wa-dropdown");
      if (dropdown) {
        dropdown.open = false;
      }
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

  private renderAvatar(option: AgentSelectOption) {
    // agents.list projects local files into validated avatarUrl data URLs. Only
    // Agents settings supplies identity.get /avatar routes together with authToken.
    const agentId = option.agent?.id;
    const identity = agentId ? (this.identityById[agentId] ?? null) : null;
    const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
    const imageUrl = url ? this.resolveRenderableAvatarUrl(url) : null;
    return renderAgentSelectAvatar(option, identity, imageUrl);
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
    if (this.disabled) {
      event.preventDefault();
      return;
    }
    const item = event.detail.item as HTMLElement & { checked?: boolean; value?: string };
    if (item.hasAttribute("data-create-agent")) {
      this.onCreateAgent?.();
      return;
    }
    const value = item.value ?? item.getAttribute("value");
    if (value === null || value === undefined) {
      return;
    }
    if (value === this.value) {
      event.preventDefault();
      item.checked = true;
      const dropdown = event.currentTarget as HTMLElement & { open: boolean };
      dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
      dropdown.open = false;
      return;
    }
    this.onSelect(value);
  };

  private readonly handleAfterShow = (event: Event) => {
    const dropdown = event.currentTarget as HTMLElement;
    const items = Array.from(
      dropdown.querySelectorAll<HTMLElement & { active: boolean }>(
        "wa-dropdown-item[data-agent-option]:not([disabled])",
      ),
    );
    const selected = items.find((item) => item.hasAttribute("data-selected")) ?? items[0];
    if (!selected) {
      return;
    }
    for (const item of items) {
      item.active = item === selected;
    }
    selected.focus({ preventScroll: true });
    selected.scrollIntoView?.({ block: "nearest" });
  };

  override render() {
    const selectedOption = this.options.find((option) => option.value === this.value);
    const missingValueOption: AgentSelectOption | null =
      !selectedOption && this.value
        ? { value: this.value, label: this.value, agent: { id: this.value } }
        : null;
    const triggerOption = selectedOption ?? missingValueOption;
    const unavailable = this.disabled || (this.options.length === 0 && !this.onCreateAgent);
    const triggerLabel = triggerOption?.label ?? (this.placeholder || t("agents.noAgents"));
    const selectedBadge = selectedOption?.badge;
    const triggerAccessibleLabel = selectedBadge
      ? `${triggerLabel}, ${selectedBadge}`
      : triggerLabel;

    return html`
      <wa-dropdown
        class="agent-select"
        placement="bottom-start"
        aria-label=${this.accessibleLabel || triggerLabel}
        @wa-select=${this.handleSelect}
        @wa-after-show=${this.handleAfterShow}
      >
        <button
          slot="trigger"
          type="button"
          class="agent-select__trigger"
          aria-label=${this.accessibleLabel
            ? `${this.accessibleLabel}: ${triggerAccessibleLabel}`
            : triggerAccessibleLabel}
          ?disabled=${unavailable}
        >
          ${triggerOption ? this.renderAvatar(triggerOption) : nothing}
          <span class="agent-select__label">${triggerLabel}</span>
          ${selectedBadge
            ? html`<span class="agent-select__badge">${selectedBadge}</span>`
            : nothing}
          <span class="agent-select__chevron" aria-hidden="true">${icons.chevronDown}</span>
        </button>
        ${this.options.map((option) => {
          const selected = option.value === this.value;
          const accessibleLabel = [option.label, option.description, option.badge]
            .filter(Boolean)
            .join(", ");
          return html`
            <wa-dropdown-item
              class="agent-select__option"
              data-agent-option
              ?data-selected=${selected}
              aria-label=${accessibleLabel}
              .value=${option.value}
              type="checkbox"
              .checked=${selected}
              ?disabled=${this.disabled || option.disabled}
              ${ref((element) => syncDropdownItemRadio(element, selected))}
            >
              <span slot="icon">${this.renderAvatar(option)}</span>
              ${renderAgentSelectCopy(option)}
              ${option.badge
                ? html`<span slot="details" class="agent-select__badge">${option.badge}</span>`
                : nothing}
            </wa-dropdown-item>
          `;
        })}
        ${this.onCreateAgent
          ? html`
              ${this.options.length > 0
                ? html`<div class="agent-select__separator" role="separator"></div>`
                : nothing}
              <wa-dropdown-item
                class="agent-select__option"
                data-create-agent
                ?disabled=${this.disabled}
              >
                <span slot="icon" class="agent-select__footer-icon" aria-hidden="true"
                  >${icons.users}</span
                >
                <span class="agent-select__option-label">${t("custodian.newAgent")}</span>
              </wa-dropdown-item>
            `
          : nothing}
      </wa-dropdown>
    `;
  }
}
