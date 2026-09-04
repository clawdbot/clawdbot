import { html, nothing, svg } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { strokeIcon } from "../../components/icons-tools.ts";
import { icons } from "../../components/icons.ts";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { moveArrayEntry, type ArrayDropPosition } from "../../lib/array-order.ts";
import { formatDurationHuman } from "../../lib/format.ts";
import type {
  ModelProviderCard,
  ModelProviderPendingLogout,
  ModelProviderProfileOrderLock,
} from "./data.ts";

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
const DROP_BEFORE_CLASS = "model-providers__profile--drop-before";
const DROP_AFTER_CLASS = "model-providers__profile--drop-after";
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

function movableOrder(
  card: ModelProviderCard,
  provider: string,
  drafts: Record<string, string[]>,
): string[] {
  return drafts[provider] ?? card.profileOrders[provider] ?? [];
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

function orderedProfiles(card: ModelProviderCard, drafts: Record<string, string[]>) {
  const providers = [
    ...new Set(
      card.profiles.map((profile) => card.profileProviderIds[profile.profileId] ?? card.id),
    ),
  ];
  const profileById = new Map(card.profiles.map((profile) => [profile.profileId, profile]));
  return providers.flatMap((provider) =>
    completeOrder(
      profilesForProvider(card, provider),
      drafts[provider] ?? card.profileOrders[provider] ?? [],
    ).flatMap((profileId) => {
      const profile = profileById.get(profileId);
      return profile ? [profile] : [];
    }),
  );
}

function rowsIn(section: HTMLElement, selector: string): HTMLElement[] {
  return [...section.querySelectorAll<HTMLElement>(selector)];
}

function clearDragState(section: HTMLElement): void {
  for (const row of rowsIn(section, ".model-providers__profile")) {
    row.classList.remove(DRAGGING_CLASS, DROP_BEFORE_CLASS, DROP_AFTER_CLASS);
  }
}

function setDropTarget(section: HTMLElement, row: HTMLElement, position: ArrayDropPosition): void {
  for (const candidate of rowsIn(section, `.${DROP_BEFORE_CLASS}, .${DROP_AFTER_CLASS}`)) {
    if (candidate !== row) {
      candidate.classList.remove(DROP_BEFORE_CLASS, DROP_AFTER_CLASS);
    }
  }
  row.classList.toggle(DROP_BEFORE_CLASS, position === "before");
  row.classList.toggle(DROP_AFTER_CLASS, position === "after");
}

function startPointerDrag(params: {
  event: PointerEvent;
  canMove: boolean;
  sourceId: string;
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
  let target: HTMLElement | null = null;
  params.event.preventDefault();
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
    const candidate = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>(".model-providers__profile");
    if (
      !candidate ||
      !section.contains(candidate) ||
      candidate.dataset.profileProvider !== params.provider ||
      candidate.dataset.profileId === params.sourceId
    ) {
      target = null;
      for (const dropRow of rowsIn(section, `.${DROP_BEFORE_CLASS}, .${DROP_AFTER_CLASS}`)) {
        dropRow.classList.remove(DROP_BEFORE_CLASS, DROP_AFTER_CLASS);
      }
      return;
    }
    target = candidate;
    const bounds = candidate.getBoundingClientRect();
    setDropTarget(
      section,
      candidate,
      event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
    );
  };
  const finish = (event: PointerEvent, apply: boolean) => {
    if (event.pointerId !== params.event.pointerId) {
      return;
    }
    update(event);
    const targetId = target?.dataset.profileId;
    const position = target?.classList.contains(DROP_AFTER_CLASS) ? "after" : "before";
    clearDragState(section);
    grip.removeEventListener("pointermove", handleMove);
    grip.removeEventListener("pointerup", handleUp);
    grip.removeEventListener("pointercancel", handleCancel);
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
  grip.addEventListener("pointermove", handleMove);
  grip.addEventListener("pointerup", handleUp);
  grip.addEventListener("pointercancel", handleCancel);
}

export function renderProviderProfiles(card: ModelProviderCard, props: ProviderProfilesViewProps) {
  if (card.profiles.length === 0) {
    return nothing;
  }
  const profiles = orderedProfiles(card, props.profileOrders);
  const providers = [
    ...new Set(profiles.map((profile) => card.profileProviderIds[profile.profileId] ?? card.id)),
  ];
  const storedOrderProviders = new Set(card.profileOrderStoredProviders);
  const reorderOffered = providers.some((provider) => {
    const order = movableOrder(card, provider, props.profileOrders);
    return (
      card.profileOrderLocks[provider] === undefined &&
      order.length > 1 &&
      hasExactProfileOrder(profilesForProvider(card, provider), order)
    );
  });
  const priorityManaged = [
    ...new Set(
      providers.flatMap((provider) => {
        const lock = card.profileOrderLocks[provider];
        return lock ? [profileOrderLockMessage(lock)] : [];
      }),
    ),
  ].join(" · ");
  const priorityAutomatic = providers.some((provider) => {
    const order = movableOrder(card, provider, props.profileOrders);
    return (
      card.profileOrderLocks[provider] === undefined &&
      !storedOrderProviders.has(provider) &&
      !hasExactProfileOrder(profilesForProvider(card, provider), order)
    );
  });
  const additionalCredentialSource = apiKeySource(card);
  return html`
    <section class="model-providers__profiles" aria-label=${t("modelProviders.profiles.title")}>
      <div class="model-providers__profiles-heading">
        <span class="model-providers__profiles-heading-copy">
          <strong>${t("modelProviders.profiles.title")}</strong>
          <span
            >${t(
              profiles.length === 1
                ? "modelProviders.profiles.accountOne"
                : "modelProviders.profiles.accounts",
              { count: String(profiles.length) },
            )}${reorderOffered ? ` · ${t("modelProviders.profiles.reorderHint")}` : ""}${
              priorityManaged
                ? ` · ${priorityManaged}`
                : priorityAutomatic
                  ? ` · ${t("modelProviders.profiles.partialOrder")}`
                  : ""
            }${additionalCredentialSource ? ` · ${additionalCredentialSource}` : ""}</span
          >
        </span>
        <span class="model-providers__profiles-heading-actions">
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
        </span>
      </div>
      <div class="model-providers__profile-list" role="list">
        ${repeat(
          profiles,
          (profile) => profile.profileId,
          (profile) => {
            const provider = card.profileProviderIds[profile.profileId] ?? card.id;
            const logoutProvider = logoutProviderForProfile(card, profile.profileId);
            const order = movableOrder(card, provider, props.profileOrders);
            const index = order.indexOf(profile.profileId);
            const complete = hasExactProfileOrder(profilesForProvider(card, provider), order);
            const lock = card.profileOrderLocks[provider];
            const locked = lock !== undefined;
            const automatic = !locked && !storedOrderProviders.has(provider) && !complete;
            const canMove =
              props.canMutate && !locked && complete && order.length > 1 && index >= 0;
            const identity = profileIdentity(profile);
            const logoutLabel = t("modelProviders.logout.actionFor", { account: identity });
            const logoutBlocked = !props.canMutate
              ? (props.mutationBlockedReason ?? "")
              : logoutLabel;
            const reorderBlocked = !props.canMutate
              ? (props.mutationBlockedReason ?? "")
              : lock
                ? profileOrderLockMessage(lock)
                : !complete
                  ? t("modelProviders.profiles.partialStoredOrder")
                  : "";
            const move = (targetId: string, position: ArrayDropPosition) => {
              const next = moveArrayEntry(order, profile.profileId, targetId, position);
              if (next.some((profileId, candidate) => profileId !== order[candidate])) {
                props.onProfileOrderChange(card.id, provider, next);
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
                  locked || automatic
                    ? html`<span
                        class="model-providers__profile-grip-spacer"
                        aria-hidden="true"
                      ></span>`
                    : html`<button
                        type="button"
                        class="model-providers__profile-grip"
                        ?disabled=${!canMove}
                        aria-label=${t("modelProviders.profiles.reorder", {
                          account: identity,
                          position: String(index + 1),
                        })}
                        aria-keyshortcuts=${canMove ? "ArrowUp ArrowDown" : nothing}
                        title=${reorderBlocked}
                        @pointerdown=${(event: PointerEvent) =>
                          startPointerDrag({
                            event,
                            canMove,
                            sourceId: profile.profileId,
                            provider,
                            move,
                          })}
                        @keydown=${(event: KeyboardEvent) => {
                          if (!canMove) {
                            return;
                          }
                          const delta =
                            event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
                          const targetId = order[index + delta];
                          if (!delta || !targetId) {
                            return;
                          }
                          event.preventDefault();
                          const grip = event.currentTarget;
                          const restoreFocus =
                            grip instanceof HTMLElement && document.activeElement === grip;
                          move(targetId, delta < 0 ? "before" : "after");
                          if (restoreFocus) {
                            // Lit moves keyed rows through removal/reinsertion, dropping focus.
                            // Restore this grip after rendering without taking focus from another control.
                            queueMicrotask(() => {
                              if (grip.isConnected && document.activeElement === document.body) {
                                grip.focus({ preventScroll: true });
                              }
                            });
                          }
                        }}
                      >
                        ${icons.gripVertical}
                      </button>`
                }
                <span class="model-providers__profile-avatar" aria-hidden="true"
                  >${profileInitials(profile)}</span
                >
                <span class="model-providers__profile-copy">
                  <strong title=${identity}>${identity}</strong>
                  <span>${profileMeta(profile)}</span>
                </span>
                <span class="model-providers__profile-status">${profileStatus(profile)}</span>
                <button
                  type="button"
                  class="model-providers__profile-logout"
                  aria-label=${logoutLabel}
                  title=${logoutBlocked}
                  ?disabled=${
                    !props.canMutate ||
                    profile.logoutSupported !== true ||
                    !logoutProvider ||
                    props.busy[`logout:${card.id}`]
                  }
                  @click=${() => {
                    if (!logoutProvider) {
                      return;
                    }
                    props.onRequestLogout({
                      cardId: card.id,
                      label: identity,
                      targets: [{ provider: logoutProvider, profileIds: [profile.profileId] }],
                    });
                  }}
                >
                  ${logoutIcon}
                </button>
              </div>
            `;
          },
        )}
      </div>
    </section>
  `;
}
