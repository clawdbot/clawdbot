import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionCreatedActor as ProtocolSessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import type { ActorIdentityUser } from "../app/user-profile.ts";
import { t } from "../i18n/index.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./viewer-facepile.ts";

export type SessionCreatedActor = ProtocolSessionCreatedActor;
export type SessionCreatorOption = SessionCreatedActor & { id: string };

export function listSessionCreators(
  sessions: readonly { createdActor?: SessionCreatedActor }[],
): SessionCreatorOption[] {
  const creators = new Map<string, SessionCreatorOption>();
  for (const session of sessions) {
    const id = session.createdActor?.id?.trim();
    if (!id) {
      continue;
    }
    const label = session.createdActor?.label?.trim();
    const existing = creators.get(id);
    if (!existing || (label && (!existing.label || label.localeCompare(existing.label) < 0))) {
      creators.set(id, {
        type: session.createdActor?.type ?? "human",
        id,
        ...(label ? { label } : {}),
      });
    }
  }
  return [...creators.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}

export function renderSessionOwnerChip(
  createdActor: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "archived" = "created",
  user?: ActorIdentityUser,
) {
  return createdActor?.id
    ? html`<openclaw-session-owner-chip
        .createdActor=${createdActor}
        .user=${user ?? null}
        size=${size}
        attribution=${attribution}
      ></openclaw-session-owner-chip>`
    : nothing;
}

function ownerInitials(createdActor: SessionCreatedActor): string {
  const source = createdActor.label?.trim() || createdActor.id?.trim() || "";
  if (!source) {
    return "";
  }
  const parts = source
    .replace(/@.*$/u, "")
    .split(/[\s._-]+/u)
    .filter(Boolean);
  const initials = ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
  return initials || source[0]!.toUpperCase();
}

// Deterministic hue per identity so a person keeps one color everywhere.
function ownerHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/**
 * Permanent session-owner avatar. Ownership is provenance, not presence:
 * this chip is solid and never pulses/expires, in deliberate contrast to the
 * translucent, ring-styled live-presence chips. Render only when the gateway
 * has 2+ distinct creator identities (solo mode shows no attribution chrome).
 * Actors absent from the current self/presence identities keep their stable
 * initials because provenance outlives presence.
 */
class SessionOwnerChip extends OpenClawLightDomElement {
  @property({ attribute: false }) createdActor: SessionCreatedActor | null = null;
  @property({ attribute: false }) user: ActorIdentityUser | null = null;
  @property({ type: String }) size: "row" | "header" = "row";
  @property({ type: String }) attribution: "created" | "archived" = "created";

  override render() {
    const createdActor = this.createdActor;
    if (!createdActor?.id) {
      return nothing;
    }
    const initials = ownerInitials(createdActor);
    if (!initials) {
      return nothing;
    }
    const title = createdActor.label || createdActor.id;
    const accessibleLabel = t(
      this.attribution === "archived" ? "sessionsView.archivedBy" : "sessionsView.createdBy",
      { name: title },
    );
    const user = this.user?.id.trim() === createdActor.id.trim() ? this.user : null;
    const avatar = user
      ? resolveAvatar({
          id: user.id,
          name: user.name,
          username: user.email,
          profileAvatarUrl: user.avatarUrl,
        })
      : null;
    return html`
      <span
        class="session-owner-chip session-owner-chip--${this.size}"
        style="--owner-hue: ${ownerHue(createdActor.id)}"
        role="img"
        aria-label=${accessibleLabel}
        title=${accessibleLabel}
        >${avatar?.kind === "profile" && user
          ? html`<openclaw-viewer-avatar
              .user=${{ ...user, watchedSessions: [] }}
              variant="session"
              aria-hidden="true"
            ></openclaw-viewer-avatar>`
          : initials}</span
      >
    `;
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
