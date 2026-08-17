import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { SessionCreatedActor as ProtocolSessionCreatedActor } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { t } from "../i18n/index.ts";
import { takeGraphemes } from "../lib/graphemes.ts";
import { resolveAvatar } from "../lib/identity-avatar.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import "./viewer-facepile.ts";

export type SessionCreatedActor = ProtocolSessionCreatedActor;
export type SessionOwnerOption = SessionCreatedActor & {
  type: "human" | "agent";
  id: string;
};

export function listSessionOwners(
  sessions: readonly {
    createdActor?: SessionCreatedActor;
    owner?: { actor: SessionCreatedActor };
  }[],
): SessionOwnerOption[] {
  const owners = new Map<string, SessionOwnerOption>();
  for (const session of sessions) {
    const actor = session.owner?.actor ?? session.createdActor;
    const id = actor?.id?.trim();
    if (!actor || !id || (actor.type !== "human" && actor.type !== "agent")) {
      continue;
    }
    const label = actor.label?.trim();
    const avatarUrl = actor.avatarUrl?.trim();
    const existing = owners.get(id);
    const nextLabel =
      label && (!existing?.label || label.localeCompare(existing.label) < 0)
        ? label
        : existing?.label;
    const nextAvatarUrl = [existing?.avatarUrl, avatarUrl]
      .filter((value): value is string => Boolean(value))
      .toSorted()[0];
    if (
      !existing ||
      actor.type !== existing.type ||
      nextLabel !== existing.label ||
      nextAvatarUrl !== existing.avatarUrl
    ) {
      owners.set(id, {
        type: actor.type,
        id,
        ...(nextLabel ? { label: nextLabel } : {}),
        ...(nextAvatarUrl ? { avatarUrl: nextAvatarUrl } : {}),
      });
    }
  }
  return [...owners.values()].toSorted((a, b) => {
    const byLabel = (a.label ?? a.id).localeCompare(b.label ?? b.id);
    return byLabel || a.id.localeCompare(b.id);
  });
}

export function listAssignableSessionOwners(params: {
  sessions: readonly {
    createdActor?: SessionCreatedActor;
    owner?: { actor: SessionCreatedActor };
  }[];
  facet?: readonly { id: string; label?: string; avatarUrl?: string }[];
  agents?: readonly { id: string; name?: string }[];
  self?: { id: string; name?: string; avatarUrl?: string } | null;
}): SessionOwnerOption[] {
  const agents = new Map((params.agents ?? []).map((agent) => [agent.id, agent] as const));
  const owners = new Map(listSessionOwners(params.sessions).map((owner) => [owner.id, owner]));
  for (const identity of params.facet ?? []) {
    const existing = owners.get(identity.id);
    const agent = agents.get(identity.id);
    owners.set(identity.id, {
      type: existing?.type ?? (agent ? "agent" : "human"),
      id: identity.id,
      ...((identity.label ?? existing?.label) ? { label: identity.label ?? existing?.label } : {}),
      ...((identity.avatarUrl ?? existing?.avatarUrl)
        ? { avatarUrl: identity.avatarUrl ?? existing?.avatarUrl }
        : {}),
    });
  }
  if (params.self?.id) {
    owners.set(params.self.id, {
      type: "human",
      id: params.self.id,
      ...(params.self.name ? { label: params.self.name } : {}),
      ...(params.self.avatarUrl ? { avatarUrl: params.self.avatarUrl } : {}),
    });
  }
  for (const agent of agents.values()) {
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
  createdActor: SessionCreatedActor | null | undefined,
  size: "row" | "header",
  attribution: "created" | "owned" | "archived" = "created",
  viewingNow?: boolean,
) {
  return createdActor?.id
    ? html`<openclaw-session-owner-chip
        .createdActor=${createdActor}
        size=${size}
        attribution=${attribution}
        .viewingNow=${viewingNow}
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

/**
 * Permanent session-owner avatar. Ownership is provenance, so the chip remains
 * when its owner leaves; live viewing only changes avatar saturation. Render
 * only when the gateway has 2+ distinct creator identities (solo mode shows no
 * attribution chrome). Human actors use the durable profile projection carried
 * by the session record; actors without it keep stable initials.
 */
class SessionOwnerChip extends OpenClawLightDomElement {
  @property({ attribute: false }) createdActor: SessionCreatedActor | null = null;
  @property({ type: String }) size: "row" | "header" = "row";
  @property({ type: String }) attribution: "created" | "owned" | "archived" = "created";
  @property({ attribute: false }) viewingNow?: boolean;

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
    const avatar = createdActor.avatarUrl
      ? resolveAvatar({
          id: createdActor.id,
          name: createdActor.label,
          profileAvatarUrl: createdActor.avatarUrl,
        })
      : null;
    return html`
      <span
        class="session-owner-chip session-owner-chip--${this.size} ${this.viewingNow === false
          ? "session-owner-chip--away"
          : ""}"
        style="--owner-hue: ${ownerHue(createdActor.id)}"
        role="img"
        aria-label=${accessibleLabel}
        title=${accessibleLabel}
        >${avatar?.kind === "profile"
          ? html`<openclaw-viewer-avatar
              .user=${{
                id: createdActor.id,
                name: createdActor.label,
                avatarUrl: createdActor.avatarUrl,
                watchedSessions: [],
              }}
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
