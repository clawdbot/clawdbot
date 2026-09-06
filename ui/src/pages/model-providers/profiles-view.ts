import { html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { moveArrayEntry, type ArrayDropPosition } from "../../lib/array-order.ts";
import { formatDurationHuman } from "../../lib/format.ts";
import type {
  ModelProviderCard,
  ModelProviderPendingLogout,
  ModelProviderProfileOrderLock,
} from "./data.ts";

registerSettingsEnglish();

type ProviderProfile = ModelProviderCard["profiles"][number];

export type ProviderProfilesViewProps = {
  busy: Record<string, boolean>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  profileOrders: Record<string, string[]>;
  onOpenModelSetup: () => void;
  onProfileOrderChange: (cardId: string, provider: string, profileIds: string[] | null) => void;
  onRequestLogout: (pending: ModelProviderPendingLogout) => void;
};

const DRAGGING_CLASS = "model-providers__profile--dragging";
const SORTING_CLASS = "model-providers__profiles--sorting";
const logoutIcon = strokeIcon(svg` <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  <polyline points="16 17 21 12 16 7" />
  <line x1="21" x2="9" y1="12" y2="12" />`);

function profileIdentity(profile: ProviderProfile): string {
  return profile.email || profile.displayName || profile.profileId;
}

function profileSource(profile: ProviderProfile): string | undefined {
  switch (profile.source) {
    case "config":
      return t("modelProviders.profiles.sourceConfig");
    case "external":
      return profile.displayName || t("modelProviders.profiles.sourceExternal");
    case "inherited":
      return t("modelProviders.profiles.sourceInherited");
    case "saved":
      return t("modelProviders.profiles.sourceSaved");
    default:
      return undefined;
  }
}

function apiKeySource(card: ModelProviderCard): string | undefined {
  if (card.apiKey?.source === "config") {
    return t("modelProviders.credentials.configKey");
  }
  if (card.apiKey?.source !== "env") {
    return undefined;
  }
  return card.apiKey.envVar
    ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
    : t("modelProviders.credentials.envKey");
}

function profileOrderLockMessage(lock: ModelProviderProfileOrderLock): string {
  return t(
    lock === "auth-config"
      ? "modelProviders.profiles.priorityManagedByAuth"
      : "modelProviders.profiles.priorityManagedByProvider",
  );
}

function profileMeta(profile: ProviderProfile): string {
  const parts: string[] = [];
  const source = profileSource(profile);
  if (source) {
    parts.push(source);
  }
  if (profile.email && profile.displayName && profile.displayName !== source) {
    parts.push(profile.displayName);
  } else if (!source && profileIdentity(profile) !== profile.profileId) {
    parts.push(profile.profileId);
  }
  if (profile.lastUsedAt) {
    parts.push(
      t("modelProviders.profiles.lastUsed", {
        time: formatDurationHuman(Date.now() - profile.lastUsedAt),
      }),
    );
  }
  return parts.join(" · ");
}

function profileInitials(profile: ProviderProfile): string {
  const localPart = profileIdentity(profile).split("@")[0] ?? "";
  const words = localPart.split(/[^a-z0-9]+/iu).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "");
  return initials.toLocaleUpperCase() || "?";
}

function profileStatus(profile: ProviderProfile) {
  if (
    profile.externallyManaged &&
    (profile.status === "expired" || profile.status === "expiring")
  ) {
    return renderSettingsStatus({ kind: "ok", label: t("modelProviders.status.ready") });
  }
  switch (profile.status) {
    case "ok":
    case "static":
      return renderSettingsStatus({ kind: "ok", label: t("modelProviders.status.ready") });
    case "expiring":
      return renderSettingsStatus({ kind: "warn", label: t("modelProviders.status.expiring") });
    case "expired":
      return renderSettingsStatus({ kind: "danger", label: t("modelProviders.status.expired") });
    default:
      return renderSettingsStatus({ kind: "muted", label: t("modelProviders.status.missing") });
  }
}

function profilesForProvider(card: ModelProviderCard, provider: string): ProviderProfile[] {
  return card.profiles.filter(
    (profile) => (card.profileProviderIds[profile.profileId] ?? card.id) === provider,
  );
}

function logoutProviderForProfile(card: ModelProviderCard, profileId: string): string | undefined {
  return card.logoutTargets.find((target) => target.profileIds.includes(profileId))?.provider;
}

function completeOrder(profiles: readonly ProviderProfile[], order: readonly string[]): string[] {
  const members = new Set(profiles.map((profile) => profile.profileId));
  return [
    ...order.filter((profileId) => members.delete(profileId)),
    ...profiles.flatMap((profile) =>
      members.delete(profile.profileId) ? [profile.profileId] : [],
    ),
  ];
}

function hasExactProfileOrder(profiles: readonly ProviderProfile[], order: readonly string[]) {
  if (profiles.length !== order.length) {
    return false;
  }
  const remaining = new Set(profiles.map((profile) => profile.profileId));
  return (
    remaining.size === profiles.length && order.every((profileId) => remaining.delete(profileId))
  );
}

function profileGroups(card: ModelProviderCard, drafts: Record<string, string[]>) {
  const providers = new Set(
    card.profiles.map((profile) => card.profileProviderIds[profile.profileId] ?? card.id),
  );
  return [...providers].map((provider) => {
    const profiles = profilesForProvider(card, provider);
    const order = drafts[provider] ?? card.profileOrders[provider] ?? [];
    const lock = card.profileOrderLocks[provider];
    const complete = hasExactProfileOrder(profiles, order);
    const stored = card.profileOrderStoredProviders.includes(provider);
    const explicit =
      drafts[provider] !== undefined || card.profileOrderExplicitProviders.includes(provider);
    const explanation = lock
      ? profileOrderLockMessage(lock)
      : !complete
        ? t(
            stored
              ? "modelProviders.profiles.partialStoredOrder"
              : "modelProviders.profiles.partialOrder",
          )
        : !explicit
          ? t("modelProviders.profiles.automaticOrder")
          : undefined;
    const profileById = new Map(profiles.map((profile) => [profile.profileId, profile]));
    return {
      provider,
      order,
      lock,
      complete,
      stored,
      explicit,
      explanation,
      profiles: completeOrder(profiles, order).flatMap((profileId) => {
        const profile = profileById.get(profileId);
        return profile ? [profile] : [];
      }),
    };
  });
}

function rowsIn(section: HTMLElement, selector: string): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>(selector)];
}

function clearDragState(section: HTMLElement): void {
  section.classList.remove(SORTING_CLASS);
  for (const row of rowsIn(section, ".model-providers__profile")) {
    row.classList.remove(DRAGGING_CLASS);
    row.style.removeProperty("translate");
  }
}

function startPointerDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  provider: string;
  move: (targetId: string, position: ArrayDropPosition) => void;
}): void {
  if (!params.canMove || params.event.button !== 0) {
    return;
  }
  const grip = params.event.currentTarget;
  if (!(grip instanceof HTMLElement)) {
    return;
  }
  const row = grip.closest<HTMLElement>(".model-providers__profile");
  const section = grip.closest<HTMLElement>(".model-providers__profiles");
  if (!row || !section) {
    return;
  }
  const sectionTop = section.getBoundingClientRect().top;
  // Use the original slots for hit testing. Measuring animated neighbors would
  // make the insertion point oscillate as they move out from under the pointer.
  const slots = rowsIn(section, ".model-providers__profile")
    .filter((candidate) => candidate.dataset.profileProvider === params.provider)
    .map((element) => ({ element, bounds: element.getBoundingClientRect() }));
  const source = slots.find((slot) => slot.element === row);
  if (!source) {
    return;
  }
  const others = slots.filter((slot) => slot !== source);
  let target: (typeof slots)[number] | undefined;
  let position: ArrayDropPosition = "before";
  params.event.preventDefault();
  section.classList.add(SORTING_CLASS);
  row.classList.add(DRAGGING_CLASS);
  try {
    grip.setPointerCapture?.(params.event.pointerId);
  } catch {
    // Synthetic pointers can lack the active pointer required for capture.
  }

  const update = (event: PointerEvent) => {
    if (event.pointerId !== params.event.pointerId) {
      return;
    }
    const scrollOffset = sectionTop - section.getBoundingClientRect().top;
    const deltaY = event.clientY - params.event.clientY + scrollOffset;
    row.style.translate = `${event.clientX - params.event.clientX}px ${deltaY}px`;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const hitRow = hit?.closest<HTMLElement>(".model-providers__profile");
    const pointerY = event.clientY + scrollOffset;
    const inside =
      hit &&
      section.contains(hit) &&
      (!hitRow || hitRow.dataset.profileProvider === params.provider) &&
      slots.some(
        ({ bounds }) =>
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          pointerY >= bounds.top &&
          pointerY <= bounds.bottom,
      );
    const centerY = source.bounds.top + source.bounds.height / 2 + deltaY;
    target = inside
      ? others.find(({ bounds }) => centerY < bounds.top + bounds.height / 2)
      : undefined;
    position = target ? "before" : "after";
    if (inside && !target) {
      target = others.at(-1);
    }
    const preview = target ? moveArrayEntry(slots, source, target, position) : slots;
    if (preview.indexOf(source) === slots.indexOf(source)) {
      target = undefined;
    }
    let top = slots[0]?.bounds.top ?? 0;
    for (const slot of preview) {
      if (slot !== source) {
        slot.element.style.translate = `0px ${top - slot.bounds.top}px`;
      }
      top += slot.bounds.height;
    }
  };
  const finish = (event: PointerEvent, apply: boolean) => {
    if (event.pointerId !== params.event.pointerId) {
      return;
    }
    update(event);
    const targetId = target?.element.dataset.profileId;
    clearDragState(section);
    grip.removeEventListener("pointermove", handleMove);
    grip.removeEventListener("pointerup", handleUp);
    grip.removeEventListener("pointercancel", handleCancel);
    grip.removeEventListener("lostpointercapture", handleCancel);
    document.removeEventListener("keydown", handleKeyDown, true);
    try {
      grip.releasePointerCapture?.(params.event.pointerId);
    } catch {
      // Pointer cancellation may release capture before this cleanup runs.
    }
    if (apply && targetId) {
      params.move(targetId, position);
    }
  };
  const handleMove = (event: PointerEvent) => update(event);
  const handleUp = (event: PointerEvent) => finish(event, true);
  const handleCancel = (event: PointerEvent) => finish(event, false);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(params.event, false);
    }
  };
  grip.addEventListener("pointermove", handleMove);
  grip.addEventListener("pointerup", handleUp);
  grip.addEventListener("pointercancel", handleCancel);
  grip.addEventListener("lostpointercapture", handleCancel);
  // A drag owns Escape before the Settings shell handles its back shortcut.
  document.addEventListener("keydown", handleKeyDown, true);
}

export function renderProviderProfiles(card: ModelProviderCard, props: ProviderProfilesViewProps) {
  if (card.profiles.length === 0) {
    return nothing;
  }
  const groups = profileGroups(card, props.profileOrders);
  const rows = groups.flatMap((group) => group.profiles.map((profile) => ({ group, profile })));
  const reorderOffered = groups.some(
    (group) => !group.lock && group.complete && group.order.length > 1,
  );
  const explanations = [
    ...new Set(groups.flatMap((group) => (group.explanation ? [group.explanation] : []))),
  ];
  const additionalCredentialSource = apiKeySource(card);
  const saving = groups.some((group) => props.profileOrders[group.provider] !== undefined);
  return html`
    <section class="model-providers__profiles" aria-label=${t("modelProviders.profiles.title")}>
      <div class="model-providers__profiles-heading">
        <div class="model-providers__profiles-heading-copy">
          <strong>${t("modelProviders.profiles.title")}</strong>
          <span
            >${t(
              rows.length === 1
                ? "modelProviders.profiles.accountOne"
                : "modelProviders.profiles.accounts",
              { count: String(rows.length) },
            )}${additionalCredentialSource ? ` · ${additionalCredentialSource}` : ""}</span
          >
          ${
            reorderOffered
              ? html`<span>${t("modelProviders.profiles.reorderHint")}</span>`
              : nothing
          }
          ${explanations.map((explanation) => html`<span>${explanation}</span>`)}
          ${saving ? html`<span role="status">${t("modelProviders.saving")}</span>` : nothing}
        </div>
        <div class="model-providers__profiles-heading-actions">
          ${card.profileOrderStoredProviders.map(
            (provider) => html`<button
              type="button"
              class="btn btn--sm btn--ghost"
              ?disabled=${!props.canMutate}
              title=${!props.canMutate ? (props.mutationBlockedReason ?? "") : ""}
              @click=${() => props.onProfileOrderChange(card.id, provider, null)}
            >
              ${t("modelProviders.profiles.resetOrder")}
            </button>`,
          )}
          <button type="button" class="btn btn--sm" @click=${props.onOpenModelSetup}>
            ${t("modelProviders.profiles.addAccount")}
          </button>
        </div>
      </div>
      <div class="model-providers__profile-list" role="list">
        ${repeat(
          rows,
          ({ profile }) => profile.profileId,
          ({ profile, group }) => {
            const { provider, order, complete, lock, stored, explicit } = group;
            const index = order.indexOf(profile.profileId);
            const canMove = props.canMutate && !lock && complete && order.length > 1 && index >= 0;
            const showMoves = !lock && (complete || stored) && order.length > 1;
            const identity = profileIdentity(profile);
            const logoutProvider = logoutProviderForProfile(card, profile.profileId);
            const logoutLabel = t("modelProviders.logout.actionFor", { account: identity });
            const logoutBlocked = !props.canMutate
              ? (props.mutationBlockedReason ?? "")
              : logoutLabel;
            const reorderBlocked = !props.canMutate
              ? (props.mutationBlockedReason ?? "")
              : (group.explanation ?? "");
            const reorder = (targetId: string, position: ArrayDropPosition) => {
              if (canMove) {
                props.onProfileOrderChange(
                  card.id,
                  provider,
                  moveArrayEntry(order, profile.profileId, targetId, position),
                );
              }
            };
            const move = (event: Event, delta: -1 | 1) => {
              const targetId = order[index + delta];
              if (!canMove || !targetId) {
                return;
              }
              const control = event.currentTarget;
              const restoreFocus =
                control instanceof HTMLButtonElement && document.activeElement === control;
              reorder(targetId, delta < 0 ? "before" : "after");
              if (restoreFocus) {
                // Lit reinserts keyed rows while reordering. Keep keyboard focus
                // on this account so the next move still acts on the same row.
                queueMicrotask(() => {
                  if (control.isConnected && document.activeElement === document.body) {
                    control.focus({ preventScroll: true });
                  }
                });
              }
            };
            return html`
              <div
                class="model-providers__profile"
                role="listitem"
                data-profile-id=${profile.profileId}
                data-profile-provider=${provider}
              >
                ${
                  showMoves
                    ? html`<button
                        type="button"
                        class="model-providers__profile-grip"
                        ?disabled=${!canMove}
                        aria-label=${t("modelProviders.profiles.reorder", { account: identity, position: String(index + 1) })}
                        aria-keyshortcuts=${canMove ? "ArrowUp ArrowDown" : nothing}
                        title=${reorderBlocked || t("modelProviders.profiles.reorderHint")}
                        @pointerdown=${(event: PointerEvent) => startPointerDrag({ event, canMove, provider, move: reorder })}
                        @keydown=${(event: KeyboardEvent) => {
                          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                            event.preventDefault();
                            move(event, event.key === "ArrowUp" ? -1 : 1);
                          }
                        }}
                      >
                        ${icons.gripVertical}
                      </button>`
                    : html`<span aria-hidden="true"></span>`
                }
                <span class="model-providers__profile-avatar" aria-hidden="true"
                  >${profileInitials(profile)}</span
                >
                <span class="model-providers__profile-copy">
                  <strong>${identity}</strong>
                  <span>${profileMeta(profile)}</span>
                </span>
                <span class="model-providers__profile-status">${profileStatus(profile)}</span>
                <span class="model-providers__profile-actions">
                  ${
                    explicit && complete && index >= 0
                      ? html`<span
                          class="model-providers__profile-position"
                          aria-label=${t("modelProviders.profiles.priority", {
                            position: String(index + 1),
                          })}
                          title=${t("modelProviders.profiles.priority", {
                            position: String(index + 1),
                          })}
                          >${index + 1}</span
                        >`
                      : nothing
                  }
                  ${
                    profile.logoutSupported === true && logoutProvider
                      ? html`<button
                          type="button"
                          class="model-providers__profile-logout"
                          aria-label=${logoutLabel}
                          title=${logoutBlocked}
                          ?disabled=${!props.canMutate || props.busy[`logout:${card.id}`]}
                          @click=${() =>
                            props.onRequestLogout({
                              cardId: card.id,
                              label: identity,
                              targets: [
                                { provider: logoutProvider, profileIds: [profile.profileId] },
                              ],
                            })}
                        >
                          ${logoutIcon}
                        </button>`
                      : nothing
                  }
                </span>
              </div>
            `;
          },
        )}
      </div>
    </section>
  `;
}
