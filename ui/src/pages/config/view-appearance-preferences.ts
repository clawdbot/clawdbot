import { html, nothing, type TemplateResult } from "lit";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import {
  normalizeCatalogOpenTarget,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  UI_APPEARANCE_DEFAULTS,
} from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import { getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import { LOBSTER_PALETTE_LORE } from "../../components/lobster-pet-lore.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  lobsterLookStyle,
  lobsterPaletteName,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import "../../components/tooltip.ts";
import {
  renderSettingsDefaultState,
  renderSettingsRow,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { languageLabel, renderLanguageSelect } from "./language-select.ts";
import { renderSessionObserverSettings } from "./session-observer-settings.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import type { ConfigProps } from "./view-types.ts";

export function serverUiPrefProvenanceHint(provenance: ServerUiPrefProvenance): string {
  if (provenance === "device-local") {
    return t("quickSettings.personal.browserOnly");
  }
  if (provenance === "pending") {
    return t("configView.syncPendingHint");
  }
  return t("configView.syncedHint");
}

export function renderLanguageSection(props: ConfigProps) {
  const defaultState = renderSettingsDefaultState({
    value: props.localeResetValue ? languageLabel(props.localeResetValue) : t("common.system"),
    overridden: props.localeOverridden,
    onReset: props.resetLocale,
  });
  const provenance = serverUiPrefProvenanceHint(props.localeProvenance);
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.language} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("quickSettings.language")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("quickSettings.language"),
          description: html`${defaultState.description} ${provenance}`,
          control: html`
            ${defaultState.action}
            ${renderLanguageSelect(props.localeOverride, props.systemLocale, props.onLocaleChange)}
          `,
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
  const refreshLabel = `${t("common.refresh")}: ${options.title}`;
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
      <button
        type="button"
        class="btn btn--sm btn--icon"
        aria-label=${refreshLabel}
        ?disabled=${state.loading}
        @click=${() => options.onRefresh?.()}
      >
        ${state.loading ? icons.loader : icons.refresh}
      </button>
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
  const messageWidthDefaultState = renderSettingsDefaultState({
    value: UI_APPEARANCE_DEFAULTS.chatMessageMaxWidth,
    overridden: props.chatMessageMaxWidth !== undefined,
    onReset: () => props.setChatMessageMaxWidth(undefined),
  });
  const sendShortcutDefaultState = renderSettingsDefaultState({
    value:
      props.chatSendShortcutResetValue === "modifier-enter"
        ? t("chat.sendShortcutModifierEnter")
        : t("chat.sendShortcutEnter"),
    overridden: props.chatSendShortcutOverridden,
    onReset: props.resetChatSendShortcut,
  });
  const sendShortcutProvenance = serverUiPrefProvenanceHint(props.chatSendShortcutProvenance);
  const followUpProvenance = serverUiPrefProvenanceHint(props.chatFollowUpModeProvenance);
  const catalogTargetDefaultState = renderSettingsDefaultState({
    value: t("chat.catalogOpenTargetViewer"),
    overridden: props.catalogOpenTarget !== UI_APPEARANCE_DEFAULTS.catalogOpenTarget,
    onReset: () => props.setCatalogOpenTarget(UI_APPEARANCE_DEFAULTS.catalogOpenTarget),
  });
  const holdToRecordDefaultState = renderSettingsDefaultState({
    value: t("common.enabled"),
    overridden:
      (props.composerHoldToRecord ?? UI_APPEARANCE_DEFAULTS.composerHoldToRecord) !==
      UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
    onReset: () => props.setComposerHoldToRecord?.(UI_APPEARANCE_DEFAULTS.composerHoldToRecord),
  });
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.chatPrefs.title")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.chatPrefs.messageWidth"),
          description: html`${t("configView.chatPrefs.messageWidthHint")}<br />
            ${messageWidthDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
          control: html` ${messageWidthDefaultState.action} ${messageWidthInput} `,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.sendShortcut"),
          value: props.chatSendShortcut,
          setting: "send-shortcut",
          description: html`${sendShortcutDefaultState.description} ${sendShortcutProvenance}`,
          actions: sendShortcutDefaultState.action,
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
          description: html`${catalogTargetDefaultState.description}
          ${t("quickSettings.personal.browserOnly")}`,
          actions: catalogTargetDefaultState.action,
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
                ${holdToRecordDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
              checked: props.composerHoldToRecord ?? UI_APPEARANCE_DEFAULTS.composerHoldToRecord,
              onChange: props.setComposerHoldToRecord,
              actions: holdToRecordDefaultState.action,
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
  const lobsterVisitsDefaultState = renderSettingsDefaultState({
    value: t("common.enabled"),
    overridden: lobsterPetVisits !== UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
    onReset: () => props.setLobsterPetVisits?.(UI_APPEARANCE_DEFAULTS.lobsterPetVisits),
  });
  const lobsterSoundsDefaultState = renderSettingsDefaultState({
    value: t("common.disabled"),
    overridden: lobsterPetSounds !== UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
    onReset: () => props.setLobsterPetSounds?.(UI_APPEARANCE_DEFAULTS.lobsterPetSounds),
  });
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
                ${lobsterVisitsDefaultState.description} ${t("quickSettings.personal.browserOnly")}`
            : html`${t("quickSettings.appearance.lobsterVisitsOff")}<br />
                ${lobsterVisitsDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
          checked: lobsterPetVisits,
          onChange: (enabled) => props.setLobsterPetVisits?.(enabled),
          actions: lobsterVisitsDefaultState.action,
        })}
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterSounds"),
          description: lobsterPetSounds
            ? html`${t("quickSettings.appearance.lobsterSoundsOn")}<br />
                ${lobsterSoundsDefaultState.description} ${t("quickSettings.personal.browserOnly")}`
            : html`${t("quickSettings.appearance.lobsterSoundsOff")}<br />
                ${lobsterSoundsDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
          checked: lobsterPetSounds,
          onChange: (enabled) => props.setLobsterPetSounds?.(enabled),
          actions: lobsterSoundsDefaultState.action,
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
  const liveActivityDefaultState = renderSettingsDefaultState({
    value: t("common.enabled"),
    overridden: props.sidebarLiveActivity !== UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
    onReset: () => props.setSidebarLiveActivity(UI_APPEARANCE_DEFAULTS.sidebarLiveActivity),
  });
  // The delete dialog's "Don't ask me again" writes this off; this row is where
  // the operator turns it back on, so it has to stay next to the session prefs.
  const setSessionDeleteConfirm = props.setSessionDeleteConfirm;
  const sessionDeleteConfirm =
    props.sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm;
  const deleteConfirmDefaultState = renderSettingsDefaultState({
    value: t("common.enabled"),
    overridden: sessionDeleteConfirm !== UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
    onReset: () => setSessionDeleteConfirm?.(UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm),
  });
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
            ${liveActivityDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
          checked: props.sidebarLiveActivity,
          onChange: props.setSidebarLiveActivity,
          actions: liveActivityDefaultState.action,
        })}
        ${setSessionDeleteConfirm
          ? renderSettingsToggleRow({
              title: t("configView.sidebarPrefs.deleteConfirm"),
              description: html`${t("configView.sidebarPrefs.deleteConfirmHint")}<br />
                ${deleteConfirmDefaultState.description} ${t("quickSettings.personal.browserOnly")}`,
              checked: sessionDeleteConfirm,
              onChange: setSessionDeleteConfirm,
              actions: deleteConfirmDefaultState.action,
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
