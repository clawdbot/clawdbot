import { html, nothing, type TemplateResult } from "lit";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import {
  normalizeCatalogOpenTarget,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
} from "../../app/settings.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { LOBSTER_PALETTE_LORE, lobsterPaletteName } from "../../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import "../../components/tooltip.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { languageLabel, renderLanguageSelect } from "./language-select.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { renderSessionObserverSettings } from "./session-observer-settings.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import type { ConfigProps } from "./view-types.ts";

export function serverUiPrefProvenanceHint(provenance: ServerUiPrefProvenance): string {
  if (provenance === "profile") {
    return t("configView.profileSyncedHint");
  }
  if (provenance === "device-local") {
    return t("quickSettings.personal.browserOnly");
  }
  if (provenance === "pending") {
    return t("configView.syncPendingHint");
  }
  return t("configView.syncedHint");
}

export function renderLanguageSection(props: ConfigProps) {
  const defaultDescription = renderSettingsDefaultDescription(
    props.localeResetValue ? languageLabel(props.localeResetValue) : t("common.system"),
    props.localeOverridden,
  );
  const provenance = serverUiPrefProvenanceHint(props.localeProvenance);
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.language} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("quickSettings.language")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("quickSettings.language"),
          description: html`${defaultDescription} ${provenance}`,
          control: renderLanguageSelect(
            props.localeOverride,
            props.systemLocale,
            props.onLocaleChange,
          ),
        })}
      </div>
    </section>
  `;
}

function renderSettingsMediaDeviceField(options: {
  state: ConfigProps["microphone"];
  title: string;
  systemDefaultLabel: string;
  emptyLabel: string;
  fallbackLabel: (number: number) => string;
  dataAttribute: "microphone" | "camera";
  onRefresh: (() => void) | undefined;
  onSelect: ((deviceId: string) => void) | undefined;
}) {
  const state = options.state;
  if (!state || !options.onSelect) {
    return nothing;
  }
  const selectedDeviceId = state.selectedDeviceId.trim();
  const selectedDeviceKnown = state.devices.some((device) => device.deviceId === selectedDeviceId);
  const selectOptions = [
    { label: options.systemDefaultLabel, value: "" },
    ...state.devices.map((device) => ({ label: device.label, value: device.deviceId })),
    // A remembered device that is unplugged right now stays selectable so the
    // choice survives until the user picks something else.
    ...(selectedDeviceId && !selectedDeviceKnown
      ? [{ label: options.fallbackLabel(state.devices.length + 1), value: selectedDeviceId }]
      : []),
  ];
  let accessRequested = false;
  const requestAccess = () => {
    if (accessRequested || !state.permissionRequired) {
      return;
    }
    accessRequested = true;
    options.onRefresh?.();
  };
  const requestAccessFromPointer = (event: PointerEvent) => {
    if (event.button === 0) {
      requestAccess();
    }
  };
  const requestAccessFromKeyboard = (event: KeyboardEvent) => {
    if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
      requestAccess();
    }
  };
  const note = state.error
    ? html`<span role="alert">${state.error}</span>`
    : !state.loading && state.devices.length === 0
      ? options.emptyLabel
      : undefined;
  return renderSettingsRow({
    title: options.title,
    description: html`${note ? html`${note}<br />` : nothing}${t(
      "quickSettings.personal.browserOnly",
    )}`,
    control: html`
      <select
        class="settings-select settings-select--media-device"
        data-settings-microphone=${options.dataAttribute === "microphone" ? "" : nothing}
        data-settings-camera=${options.dataAttribute === "camera" ? "" : nothing}
        aria-label=${options.title}
        .value=${selectedDeviceId}
        @pointerdown=${requestAccessFromPointer}
        @keydown=${requestAccessFromKeyboard}
        @change=${(event: Event) =>
          options.onSelect?.((event.currentTarget as HTMLSelectElement).value)}
      >
        ${selectOptions.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === selectedDeviceId}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    `,
  });
}

function renderSettingsMicrophoneField(props: ConfigProps) {
  return renderSettingsMediaDeviceField({
    state: props.microphone,
    title: t("chat.composer.microphoneInput"),
    systemDefaultLabel: t("chat.composer.systemDefaultMicrophone"),
    emptyLabel: t("chat.composer.noMicrophones"),
    fallbackLabel: (number) => t("chat.composer.microphoneFallback", { number: String(number) }),
    dataAttribute: "microphone",
    onRefresh: props.onMicrophoneRefresh,
    onSelect: props.onMicrophoneSelect,
  });
}

function renderSettingsCameraField(props: ConfigProps) {
  return renderSettingsMediaDeviceField({
    state: props.camera,
    title: t("chat.composer.cameraInput"),
    systemDefaultLabel: t("chat.composer.systemDefaultCamera"),
    emptyLabel: t("chat.composer.noCameras"),
    fallbackLabel: (number) => t("chat.composer.cameraFallback", { number: String(number) }),
    dataAttribute: "camera",
    onRefresh: props.onCameraRefresh,
    onSelect: props.onCameraSelect,
  });
}

export function renderChatPreferencesSection(
  props: ConfigProps,
  messageWidthInput: TemplateResult,
) {
  const followUpSelection = props.chatFollowUpMode ?? "server";
  const serverQueueMode = props.serverQueueMode ?? t("chat.followUpModeLoading");
  const followUpDescription = props.chatFollowUpMode
    ? t("chat.followUpModeOverriding", { mode: serverQueueMode })
    : t("chat.followUpModeUsingServer", { mode: serverQueueMode });
  const messageWidthDefaultDescription = renderSettingsDefaultDescription(
    UI_APPEARANCE_DEFAULTS.chatMessageMaxWidth,
    props.chatMessageMaxWidth !== undefined,
  );
  const sendShortcutDefaultDescription = renderSettingsDefaultDescription(
    props.chatSendShortcutResetValue === "modifier-enter"
      ? t("chat.sendShortcutModifierEnter")
      : t("chat.sendShortcutEnter"),
    props.chatSendShortcutOverridden,
  );
  const sendShortcutProvenance = serverUiPrefProvenanceHint(props.chatSendShortcutProvenance);
  const followUpProvenance = serverUiPrefProvenanceHint(props.chatFollowUpModeProvenance);
  const catalogTargetDefaultDescription = renderSettingsDefaultDescription(
    t("chat.catalogOpenTargetViewer"),
    props.catalogOpenTarget !== UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
  );
  const holdToRecordDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    (props.composerHoldToRecord ?? UI_APPEARANCE_DEFAULTS.composerHoldToRecord) !==
      UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
  );
  const collapseTaskProgressDefaultDescription = renderSettingsDefaultDescription(
    t("common.disabled"),
    props.chatCollapseTaskProgress !== UI_APPEARANCE_DEFAULTS.chatCollapseTaskProgress,
  );
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.chatPrefs.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.chatPrefs.messageWidth"),
          description: html`${t("configView.chatPrefs.messageWidthHint")}<br />
            ${messageWidthDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          control: messageWidthInput,
        })}
        ${renderSettingsToggleRow({
          title: t("configView.chatPrefs.collapseTaskProgress"),
          description: html`${t("configView.chatPrefs.collapseTaskProgressHint")}<br />
            ${collapseTaskProgressDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.chatCollapseTaskProgress,
          onChange: props.setChatCollapseTaskProgress,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.sendShortcut"),
          value: props.chatSendShortcut,
          setting: "send-shortcut",
          description: html`${sendShortcutDefaultDescription} ${sendShortcutProvenance}`,
          options: [
            { value: "enter", label: t("chat.sendShortcutEnter") },
            { value: "modifier-enter", label: t("chat.sendShortcutModifierEnter") },
          ],
          onChange: (value) => props.setChatSendShortcut(normalizeChatSendShortcut(value)),
        })}
        ${renderSettingsRow({
          title: t("chat.followUpMode"),
          description: html`${followUpDescription} ${followUpProvenance}`,
          control: html`
            <select
              class="settings-select"
              data-settings-follow-up-mode
              aria-label=${t("chat.followUpMode")}
              .value=${followUpSelection}
              @change=${(event: Event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                props.setChatFollowUpMode(
                  value === "server" ? undefined : normalizeChatFollowUpMode(value),
                );
              }}
            >
              <option value="server" ?selected=${followUpSelection === "server"}>
                ${t("chat.followUpModeServer", { mode: serverQueueMode })}
              </option>
              <option value="steer" ?selected=${followUpSelection === "steer"}>
                ${t("chat.followUpModeSteer")}
              </option>
              <option value="queue" ?selected=${followUpSelection === "queue"}>
                ${t("chat.followUpModeQueue")}
              </option>
            </select>
            ${props.chatFollowUpModeOverridden
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  @click=${props.resetChatFollowUpMode}
                >
                  ${t("chat.followUpModeReset")}
                </button>`
              : nothing}
          `,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.catalogOpenTarget"),
          value: props.catalogOpenTarget,
          setting: "catalog-open-target",
          description: html`${catalogTargetDefaultDescription}
          ${t("quickSettings.personal.browserOnly")}`,
          options: [
            { value: "viewer", label: t("chat.catalogOpenTargetViewer") },
            { value: "terminal", label: t("chat.catalogOpenTargetTerminal") },
          ],
          onChange: (value) => props.setCatalogOpenTarget(normalizeCatalogOpenTarget(value)),
        })}
        ${renderSettingsMicrophoneField(props)} ${renderSettingsCameraField(props)}
        ${props.setComposerHoldToRecord
          ? renderSettingsToggleRow({
              title: t("chat.composer.holdToRecordSetting"),
              description: html`${t("chat.composer.holdToRecordSettingDescription")}<br />
                ${holdToRecordDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
              checked: props.composerHoldToRecord ?? UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
              onChange: props.setComposerHoldToRecord,
            })
          : nothing}
      </div>
    </section>
  `;
}

// Lobster pet toggles and the Lobsterdex live with the rest of the appearance
// prefs; the toggles are browser-local, so embedded editors omit this section.
export function renderLobsterPetSection(props: ConfigProps) {
  if (!props.setLobsterPetVisits || !props.setLobsterPetSounds) {
    return nothing;
  }
  const lobsterPetVisits = props.lobsterPetVisits ?? UI_APPEARANCE_DEFAULTS.lobsterPetVisits;
  const lobsterPetSounds = props.lobsterPetSounds ?? UI_APPEARANCE_DEFAULTS.lobsterPetSounds;
  const lobsterVisitsDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    lobsterPetVisits !== UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
  );
  const lobsterSoundsDefaultDescription = renderSettingsDefaultDescription(
    t("common.disabled"),
    lobsterPetSounds !== UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
  );
  const dexEntries = getLobsterdexEntries();
  const seenCount = LOBSTER_PET_PALETTES.filter((palette) => dexEntries.has(palette.id)).length;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("quickSettings.appearance.lobsterdex")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterVisits"),
          description: lobsterPetVisits
            ? html`${t("quickSettings.appearance.lobsterVisitsOn")}<br />
                ${lobsterVisitsDefaultDescription} ${t("quickSettings.personal.browserOnly")}`
            : html`${t("quickSettings.appearance.lobsterVisitsOff")}<br />
                ${lobsterVisitsDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: lobsterPetVisits,
          onChange: (enabled) => props.setLobsterPetVisits?.(enabled),
        })}
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterSounds"),
          description: lobsterPetSounds
            ? html`${t("quickSettings.appearance.lobsterSoundsOn")}<br />
                ${lobsterSoundsDefaultDescription} ${t("quickSettings.personal.browserOnly")}`
            : html`${t("quickSettings.appearance.lobsterSoundsOff")}<br />
                ${lobsterSoundsDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: lobsterPetSounds,
          onChange: (enabled) => props.setLobsterPetSounds?.(enabled),
          onAct: (enabled) => {
            if (enabled) {
              previewLobsterChirp();
            }
          },
        })}
        ${renderSettingsRow({
          title: t("quickSettings.appearance.lobsterdex"),
          description: t("quickSettings.appearance.lobsterdexSeen", {
            seen: String(seenCount),
            total: String(LOBSTER_PET_PALETTES.length),
          }),
          stacked: true,
          control: html`
            <div class="lobsterdex__gallery">
              <div class="lobsterdex">
                ${LOBSTER_PET_PALETTES.map((palette) => {
                  const look = canonicalLobsterLook(palette);
                  const entry = dexEntries.get(palette.id);
                  const seen = entry !== undefined;
                  const shinySeen = entry?.shinySeenAt != null;
                  const baseName = seen ? (entry.name ?? lobsterPaletteName(palette.id)) : "?";
                  const displayName = shinySeen ? `${baseName} ✦` : baseName;
                  const lore = LOBSTER_PALETTE_LORE[palette.id];
                  const loreLine = seen ? lore.flavor : lore.hint;
                  const visitedLine =
                    seen && entry.firstSeenAt !== null
                      ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                          name: baseName,
                          date: new Date(entry.firstSeenAt).toLocaleDateString(),
                        })
                      : null;
                  const ariaLabel = [displayName, loreLine, visitedLine]
                    .filter((line): line is string => line !== null)
                    .join("\n");
                  return html`
                    <openclaw-tooltip>
                      <span
                        class="lobsterdex__mini lobster-pet--palette-${palette.id} ${seen
                          ? ""
                          : "lobsterdex__mini--unseen"}"
                        style=${lobsterLookStyle(look)}
                        tabindex="0"
                        role="img"
                        aria-label=${ariaLabel}
                      >
                        ${renderLobsterSvg(look, { standalone: true })}
                        ${shinySeen
                          ? html`<span class="lobsterdex__mini-star" aria-hidden="true">✦</span>`
                          : nothing}
                      </span>
                      <span slot="content" class="lobsterdex__tooltip">
                        <strong>${displayName}</strong>
                        <span>${loreLine}</span>
                        ${visitedLine ? html`<span>${visitedLine}</span>` : nothing}
                      </span>
                    </openclaw-tooltip>
                  `;
                })}
              </div>
              ${props.lobsterdexHref
                ? html`<a
                    class="btn btn--sm lobsterdex__open"
                    href=${props.lobsterdexHref}
                    @click=${(event: MouseEvent) => {
                      if (!shouldHandleNavigationClick(event)) {
                        return;
                      }
                      event.preventDefault();
                      props.onOpenLobsterdex?.();
                    }}
                    >${t("quickSettings.appearance.lobsterdexOpen")}</a
                  >`
                : nothing}
            </div>
          `,
        })}
      </div>
    </section>
  `;
}

export function renderSidebarPreferencesSection(props: ConfigProps) {
  const hiddenCatalogIds = [...props.hiddenSessionCatalogIds].toSorted();
  const liveActivityDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    props.sidebarLiveActivity !== UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
  );
  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.
  const setSessionDeleteConfirm = props.setSessionDeleteConfirm;
  const sessionDeleteConfirm =
    props.sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm;
  const deleteConfirmDefaultDescription = renderSettingsDefaultDescription(
    t("common.enabled"),
    sessionDeleteConfirm !== UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
  );
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.sidebarPrefs.title")}</h2>
      </div>
      <p class="settings-section__desc">${t("configView.sidebarPrefs.hint")}</p>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("configView.sidebarPrefs.liveActivity"),
          description: html`${t("configView.sidebarPrefs.liveActivityHint")}<br />
            ${liveActivityDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.sidebarLiveActivity,
          onChange: props.setSidebarLiveActivity,
        })}
        ${setSessionDeleteConfirm
          ? renderSettingsToggleRow({
              title: t("configView.sidebarPrefs.deleteConfirm"),
              description: html`${t("configView.sidebarPrefs.deleteConfirmHint")}<br />
                ${deleteConfirmDefaultDescription} ${t("quickSettings.personal.browserOnly")}`,
              checked: sessionDeleteConfirm,
              onChange: setSessionDeleteConfirm,
            })
          : nothing}
      </div>
      ${hiddenCatalogIds.length > 0
        ? html`
            <div class="settings-section__header settings-section__header--subsection">
              <h3 class="settings-section__heading">${t("chat.sidebar.hiddenSessionSections")}</h3>
            </div>
            <div class="settings-group">
              ${hiddenCatalogIds.map((catalogId) =>
                renderSettingsRow({
                  title: props.hiddenSessionCatalogLabels.get(catalogId) ?? catalogId,
                  description: t("quickSettings.personal.browserOnly"),
                  control: html`<button
                    type="button"
                    class="btn btn--sm"
                    @click=${() => props.setSessionCatalogHidden(catalogId, false)}
                  >
                    ${t("chat.sidebar.showSessionSection")}
                  </button>`,
                }),
              )}
            </div>
          `
        : nothing}
      <div class="settings-section__header settings-section__header--subsection">
        <h3 class="settings-section__heading">${t("configView.sessionObserver.title")}</h3>
      </div>
      <p class="settings-section__desc">${t("configView.sessionObserver.hint")}</p>
      ${renderSessionObserverSettings({
        enabled: props.sessionObserverEnabled !== false,
        utilityModel: props.sessionObserverUtilityModel,
        resolvedUtilityModel: props.sessionObserverResolvedModel,
        models: props.sessionObserverModels ?? [],
        modelsUnavailable: props.sessionObserverModelsUnavailable === true,
        disabled: props.sessionObserverDisabled === true,
        onEnabledChange: (enabled) => props.setSessionObserverEnabled?.(enabled),
        onUtilityModelChange: (selection) => props.setSessionObserverUtilityModel?.(selection),
      })}
    </section>
  `;
}
