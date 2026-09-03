import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionParticipant } from "../../../packages/gateway-protocol/src/schema/session-participant.js";
import type { SessionCreatedActor as ProtocolSessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { SessionsListResult } from "../api/types.ts";
import type { AuthenticatedUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./viewer-facepile.ts";

export type SessionCreatedActor = ProtocolSessionCreatedActor;
export type SessionOwnerOption = NonNullable<SessionsListResult["owners"]>[number];

export function sessionSelfOwner(
  self: AuthenticatedUser | null | undefined,
): SessionOwnerOption | null {
  return self
    ? {
        type: "human",
        id: self.id,
        identity: { type: "profile", id: self.id },
        label: self.name,
        avatarUrl: self.avatarUrl,
      }
    : null;
}

export function renderSessionOwnerChip(
  owner: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
  participants?: readonly SessionParticipant[],
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

export function renderSessionOwnerAvatar(
  owner: Pick<SessionOwnerOption, "id" | "label" | "avatarUrl" | "identity">,
) {
  return html`<openclaw-viewer-avatar
    .identity=${owner.identity}
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
  @property({ attribute: false }) participants: readonly SessionParticipant[] = [];
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
    const avatar = resolveAvatar({
      id: owner.id,
      identity: owner.identity,
      name: owner.label,
      profileAvatarUrl: owner.avatarUrl,
    });
    const stacked = this.size === "row" && this.participantCount > 0;
    const chip = html`
      <span
        class="session-owner-chip session-owner-chip--${this.size} ${this.viewingNow === false
          ? "session-owner-chip--away"
          : ""} ${stacked ? "session-owner-stack__front" : ""}"
        style="--owner-hue: ${ownerHue(owner.id)}"
        role="img"
        aria-label=${accessibleLabel}
        title=${accessibleLabel}
        >${avatar?.kind === "profile"
          ? renderSessionOwnerAvatar({ ...owner, id: owner.id })
          : initials}</span
      >
    `;
    if (!stacked) {
      return chip;
    }
    const participant = this.participants[0];
    const participantTitle = participant?.label || participant?.identity.id;
    const combinedLabel =
      this.participantCount === 1 && participantTitle
        ? `${accessibleLabel} · ${t("sessionsView.withParticipant", { name: participantTitle })}`
        : `${accessibleLabel} · ${t("sessionsView.withMoreParticipants", { count: String(this.participantCount) })}`;
    return html`<span class="session-owner-stack" role="group" aria-label=${combinedLabel}>
      <span class="session-owner-stack__back" aria-hidden="true">
        ${this.participantCount === 1 && participant
          ? renderSessionOwnerAvatar({ ...participant, id: participant.identity.id })
          : html`<span class="session-owner-stack__overflow">+${this.participantCount}</span>`}
      </span>
      ${chip}
    </span>`;
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
