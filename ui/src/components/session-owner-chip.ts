import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionCreatedActor as ProtocolSessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionsListResult } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./viewer-facepile.ts";
import "./tooltip.ts";

export type SessionCreatedActor = ProtocolSessionCreatedActor;
export type SessionOwnerOption = NonNullable<SessionsListResult["owners"]>[number];

export function listAssignableSessionOwners(params: {
  facet?: SessionsListResult["owners"];
  agents?: readonly { id: string; name?: string }[];
  self?: { id: string; name?: string; avatarUrl?: string } | null;
}): SessionOwnerOption[] {
  const owners = new Map((params.facet ?? []).map((owner) => [owner.id, owner]));
  if (params.self?.id && owners.get(params.self.id)?.type !== "agent") {
    owners.set(params.self.id, {
      type: "human",
      id: params.self.id,
      ...(params.self.name ? { label: params.self.name } : {}),
      ...(params.self.avatarUrl ? { avatarUrl: params.self.avatarUrl } : {}),
    });
  }
  for (const agent of params.agents ?? []) {
    owners.set(agent.id, {
      type: "agent",
      id: agent.id,
      ...(agent.name ? { label: agent.name } : {}),
    });
  }
  return [...owners.values()].toSorted(
    (left, right) =>
      left.type.localeCompare(right.type) ||
      (left.label ?? left.id).localeCompare(right.label ?? right.id) ||
      left.id.localeCompare(right.id),
  );
}

export function renderSessionOwnerChip(
  owner: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
  participants?: readonly SessionCreatedActor[],
  participantCount?: number,
) {
  return owner?.id
    ? html`<openclaw-session-owner-chip
        .owner=${owner}
        size=${size}
        attribution=${attribution}
        .viewingNow=${viewingNow}
        .participants=${participants ?? []}
        .participantCount=${participantCount ?? participants?.length ?? 0}
      ></openclaw-session-owner-chip>`
    : nothing;
}

export function sessionOwnerInitials(owner: SessionCreatedActor): string {
  const source = owner.label?.trim() || owner.id?.trim() || "";
  if (!source) {
    return "";
  }
  const parts = source
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  // Grapheme clusters, not UTF-16 units or bare code points: emoji display names
  // must render their complete visible initial (no lone surrogates or split ZWJ sequences).
  const firstChar = (value: string | undefined): string => (value ? takeGraphemes(value, 1) : "");
  const initials = (firstChar(parts[0]) + firstChar(parts[1])).toUpperCase();
  return initials || firstChar(source).toUpperCase();
}

// Deterministic hue per identity so a person keeps one color everywhere.
function ownerHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function renderSessionOwnerMenuAvatar(owner: SessionOwnerOption) {
  return html`<openclaw-viewer-avatar
    .user=${{
      id: owner.id,
      name: owner.label,
      avatarUrl: owner.avatarUrl,
      watchedSessions: [],
    }}
    .markAsViewer=${false}
    variant="session"
    aria-hidden="true"
  ></openclaw-viewer-avatar>`;
}

/**
 * Session-owner avatar. The owner may be reassigned; live viewing only changes
 * avatar saturation. Render only when the Gateway's complete owner facet has 2+
 * identities (solo mode shows no attribution chrome). Human actors use the durable
 * profile projection carried by the session record; actors without it keep stable initials.
 */
class SessionOwnerChip extends OpenClawLightDomElement {
  @property({ attribute: false }) owner: SessionCreatedActor | null = null;
  @property({ type: String }) size: "row" | "header" = "row";
  @property({ type: String }) attribution: "created" | "owned" | "archived" = "created";
  @property({ attribute: false }) viewingNow?: boolean;
  @property({ attribute: false }) participants: readonly SessionCreatedActor[] = [];
  @property({ type: Number }) participantCount = 0;

  override render() {
    const owner = this.owner;
    if (!owner?.id) {
      return nothing;
    }
    const initials = sessionOwnerInitials(owner);
    if (!initials) {
      return nothing;
    }
    const title = owner.label || owner.id;
    const attributionKey =
      this.attribution === "archived"
        ? "sessionsView.archivedBy"
        : this.attribution === "owned"
          ? "sessionsView.ownedBy"
          : "sessionsView.createdBy";
    const attributionLabel = t(attributionKey, { name: title });
    const accessibleLabel = this.viewingNow
      ? `${attributionLabel} · ${t("sessionsView.viewingNow")}`
      : attributionLabel;
    const avatar = owner.avatarUrl
      ? resolveAvatar({
          id: owner.id,
          name: owner.label,
          profileAvatarUrl: owner.avatarUrl,
        })
      : null;
    if (this.size === "row" && this.participantCount > 0) {
      const participant = this.participants[0];
      const participantTitle = participant?.label || participant?.id;
      const combinedLabel =
        this.participantCount === 1 && participantTitle
          ? `${accessibleLabel} · ${t("sessionsView.withParticipant", { name: participantTitle })}`
          : `${accessibleLabel} · ${t("sessionsView.withMoreParticipants", { count: String(this.participantCount) })}`;
      return html`
        <span class="session-owner-stack" role="group" aria-label=${combinedLabel}>
          <span class="session-owner-stack__back" aria-hidden="true">
            ${this.participantCount === 1 && participant?.id
              ? html`<openclaw-viewer-avatar
                  .user=${{
                    id: participant.id,
                    name: participant.label,
                    avatarUrl: participant.avatarUrl,
                    watchedSessions: [],
                  }}
                  .markAsViewer=${false}
                  variant="session"
                ></openclaw-viewer-avatar>`
              : html`<span class="session-owner-stack__overflow">+${this.participantCount}</span>`}
          </span>
          <span
            class="session-owner-chip session-owner-chip--${this.size} ${this.viewingNow === false
              ? "session-owner-chip--away"
              : ""} session-owner-stack__front"
            style="--owner-hue: ${ownerHue(owner.id)}"
            role="img"
            aria-label=${accessibleLabel}
            title=${accessibleLabel}
            >${avatar?.kind === "profile"
              ? html`<openclaw-viewer-avatar
                  .user=${{
                    id: owner.id,
                    name: owner.label,
                    avatarUrl: owner.avatarUrl,
                    watchedSessions: [],
                  }}
                  .markAsViewer=${false}
                  variant="session"
                  aria-hidden="true"
                ></openclaw-viewer-avatar>`
              : initials}</span
          >
        </span>
      `;
    }
    const ownerChip = html`
      <span
        class="session-owner-chip session-owner-chip--${this.size} ${this.viewingNow === false
          ? "session-owner-chip--away"
          : ""}"
        style="--owner-hue: ${ownerHue(owner.id)}"
        role="img"
        aria-label=${accessibleLabel}
        title=${this.size === "header" ? nothing : accessibleLabel}
        >${avatar?.kind === "profile"
          ? html`<openclaw-viewer-avatar
              .user=${{
                id: owner.id,
                name: owner.label,
                avatarUrl: owner.avatarUrl,
                watchedSessions: [],
              }}
              .markAsViewer=${false}
              variant="session"
              aria-hidden="true"
            ></openclaw-viewer-avatar>`
          : initials}</span
      >
    `;
    return this.size === "header"
      ? html`<openclaw-tooltip .content=${attributionLabel}>${ownerChip}</openclaw-tooltip>`
      : ownerChip;
  }
}

if (!customElements.get("openclaw-session-owner-chip")) {
  customElements.define("openclaw-session-owner-chip", SessionOwnerChip);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-session-owner-chip": SessionOwnerChip;
  }
}
