import { html, nothing, type TemplateResult } from "lit";
import {
  normalizeCatalogOpenTarget,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
} from "../../app/settings.ts";
import { icons } from "../../components/icons.ts";
import { getLobsterdex, getLobsterdexEntries } from "../../components/lobster-dex.ts";
import { previewLobsterChirp } from "../../components/lobster-pet-audio.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import { renderSettingsRow, renderSettingsToggleRow } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { renderSessionObserverSettings } from "./session-observer-settings.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import type { ConfigProps } from "./view-types.ts";

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
    description: note,
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
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.chatPrefs.title")}</h2>
      </div>
      <p class="settings-section__desc">
        ${t("configView.chatPrefs.hint")} ${t("configView.syncedHint")}
      </p>
      <div class="settings-group">
        ${renderSettingsRow({
          title: t("configView.chatPrefs.messageWidth"),
          description: t("configView.chatPrefs.messageWidthHint"),
          control: html`
            ${messageWidthInput}
            ${props.chatMessageMaxWidth
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  @click=${() => props.setChatMessageMaxWidth(undefined)}
                >
                  ${t("common.reset")}
                </button>`
              : nothing}
          `,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.sendShortcut"),
          value: props.chatSendShortcut,
          setting: "send-shortcut",
          options: [
            { value: "enter", label: t("chat.sendShortcutEnter") },
            { value: "modifier-enter", label: t("chat.sendShortcutModifierEnter") },
          ],
          onChange: (value) => props.setChatSendShortcut(normalizeChatSendShortcut(value)),
        })}
        ${renderSettingsRow({
          title: t("chat.followUpMode"),
          description: followUpDescription,
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
            ${props.chatFollowUpMode
              ? html`<button
                  type="button"
                  class="btn btn--sm"
                  @click=${() => props.setChatFollowUpMode(undefined)}
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
              description: t("chat.composer.holdToRecordSettingDescription"),
              checked: props.composerHoldToRecord !== false,
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
  const lobsterPetVisits = props.lobsterPetVisits === true;
  const lobsterPetSounds = props.lobsterPetSounds === true;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("quickSettings.appearance.lobsterdex")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterVisits"),
          description: lobsterPetVisits
            ? t("quickSettings.appearance.lobsterVisitsOn")
            : t("quickSettings.appearance.lobsterVisitsOff"),
          checked: lobsterPetVisits,
          onChange: (enabled) => props.setLobsterPetVisits?.(enabled),
        })}
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterSounds"),
          description: lobsterPetSounds
            ? t("quickSettings.appearance.lobsterSoundsOn")
            : t("quickSettings.appearance.lobsterSoundsOff"),
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
            seen: String(LOBSTER_PET_PALETTES.filter((p) => getLobsterdex().has(p.id)).length),
            total: String(LOBSTER_PET_PALETTES.length),
          }),
          stacked: true,
          control: html`<div class="lobsterdex">
            ${LOBSTER_PET_PALETTES.map((palette) => {
              const entry = getLobsterdexEntries().get(palette.id);
              const seen = entry !== undefined;
              const shinySeen = entry?.shinySeenAt != null;
              const title = !seen
                ? "?"
                : entry.firstSeenAt !== null
                  ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                      name: entry.name ?? palette.id,
                      date: new Date(entry.firstSeenAt).toLocaleDateString(),
                    })
                  : (entry.name ?? palette.id);
              return html`<span
                class="lobsterdex__mini lobster-pet--palette-${palette.id} ${seen
                  ? ""
                  : "lobsterdex__mini--unseen"}"
                style="--lob-shell:${palette.shell};--lob-claw:${palette.claw}"
                title=${shinySeen ? `${title} ✦` : title}
              >
                ${renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true })}
                ${shinySeen
                  ? html`<span class="lobsterdex__mini-star" aria-hidden="true">✦</span>`
                  : nothing}
              </span>`;
            })}
          </div>`,
        })}
      </div>
    </section>
  `;
}

export function renderSidebarPreferencesSection(props: ConfigProps) {
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.sidebarPrefs.title")}</h2>
      </div>
      <p class="settings-section__desc">${t("configView.sidebarPrefs.hint")}</p>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("configView.sidebarPrefs.liveActivity"),
          description: t("configView.sidebarPrefs.liveActivityHint"),
          checked: props.sidebarLiveActivity,
          onChange: props.setSidebarLiveActivity,
        })}
      </div>
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
