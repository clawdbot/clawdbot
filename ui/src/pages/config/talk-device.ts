import { html, nothing } from "lit";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";

registerSettingsEnglish();

type DeviceLocaleSelection = { primary: string; additional: string[] };
const pendingDeviceLocales = new WeakMap<
  NativeDeviceSettingsCapability,
  Partial<DeviceLocaleSelection>
>();

function deviceLocaleSelection(
  capability: NativeDeviceSettingsCapability,
): DeviceLocaleSelection | null {
  const locale = capability.snapshot?.voice.locale;
  if (!locale) {
    return null;
  }
  const pending = pendingDeviceLocales.get(capability);
  const primary = pending?.primary ?? locale.primary;
  return {
    primary,
    additional: [...new Set(pending?.additional ?? locale.additional)].filter(
      (id) => id !== primary,
    ),
  };
}

function changeDeviceLocales(
  capability: NativeDeviceSettingsCapability,
  change: Partial<DeviceLocaleSelection>,
) {
  const pending = pendingDeviceLocales.get(capability);
  if (pending) {
    Object.assign(pending, change);
  } else {
    const desired = { ...change };
    pendingDeviceLocales.set(capability, desired);
    const unsubscribe = capability.subscribe((snapshot) => {
      // Only a published snapshot can acknowledge an intent. Reading the old
      // snapshot during another edit must not clear a pending return to that value.
      const locale = snapshot.voice.locale;
      if (desired.primary === locale.primary) {
        delete desired.primary;
      }
      if (
        desired.additional &&
        desired.additional.length === locale.additional.length &&
        desired.additional.every((id, index) => id === locale.additional[index])
      ) {
        delete desired.additional;
      }
      if (desired.primary === undefined && desired.additional === undefined) {
        pendingDeviceLocales.delete(capability);
        unsubscribe();
      }
    });
  }
  if (change.additional) {
    capability.set("voice.locale.additional", change.additional);
  }
  if (change.primary !== undefined) {
    capability.set("voice.locale.primary", change.primary);
  }
}

export type VoiceWakeEditorState =
  | { kind: "unavailable" }
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ready"; text: string; phase: "saved" | "pending" | "saving"; error: string | null };

export function renderVoiceWakeEditor(
  state: VoiceWakeEditorState,
  onInput: (text: string) => void,
  onRetry: () => void,
) {
  return renderSettingsSection(
    { title: t("configPage.deviceTalk.triggerWords") },
    renderSettingsRow({
      title: t("configPage.deviceTalk.triggerWords"),
      description: t("configPage.deviceTalk.triggerWordsHint"),
      stacked: true,
      control: html`
        ${
          state.kind === "ready"
            ? html`<textarea
                class="settings-input"
                aria-label=${t("configPage.deviceTalk.triggerWords")}
                rows="4"
                .value=${state.text}
                @input=${(event: Event) => {
                  // SAFETY: This listener is bound directly to the textarea, so currentTarget is that textarea.
                  onInput((event.currentTarget as HTMLTextAreaElement).value);
                }}
              ></textarea>`
            : nothing
        }
        ${
          state.kind === "error" || (state.kind === "ready" && state.error)
            ? html`<div class="callout danger" role="alert">
                ${state.error}
                <button class="btn btn--sm" type="button" @click=${onRetry}>
                  ${t("common.retry")}
                </button>
              </div>`
            : state.kind === "unavailable"
              ? html`<span class="muted"
                  >${t("configPage.deviceTalk.triggerWordsUnavailable")}</span
                >`
              : html`<span class="muted" role="status"
                  >${state.kind === "loading" ? t("common.loading") : state.kind === "ready" && state.phase !== "saved" ? t("common.saving") : t("configPage.deviceTalk.saved")}</span
                >`
        }
      `,
    }),
  );
}

export function renderDeviceTalk(capability: NativeDeviceSettingsCapability | null | undefined) {
  if (!capability) {
    return nothing;
  }
  const voice = capability.snapshot?.voice;
  if (!voice) {
    return renderSettingsSection(
      { title: t("configPage.deviceTalk.title") },
      renderSettingsRow({ title: t("common.loading") }),
    );
  }
  const microphoneOptions = [
    { value: "", label: t("configPage.deviceTalk.systemDefault") },
    ...voice.microphone.devices.map(({ id, name }) => ({ value: id, label: name })),
  ];
  if (
    voice.microphone.selectedId &&
    !voice.microphone.devices.some(({ id }) => id === voice.microphone.selectedId)
  ) {
    microphoneOptions.push({
      value: voice.microphone.selectedId,
      label: t("configPage.deviceTalk.disconnectedMicrophone", { id: voice.microphone.selectedId }),
    });
  }
  const languageOptions = voice.locale.available.map(({ id, name }) => ({
    value: id,
    label: name,
  }));
  const locale = deviceLocaleSelection(capability);
  if (!locale) {
    return nothing;
  }
  return renderSettingsSection({ title: t("configPage.deviceTalk.title") }, [
    ...(
      [
        "wakeEnabled",
        "wakeTriggersTalkMode",
        "pushToTalkEnabled",
        "talkShiftToStopEnabled",
        "talkPhaseSoundsEnabled",
        "realtimeRelayEnabled",
        "triggerChime",
        "sendChime",
      ] as const
    ).map((key) =>
      renderSettingsToggleRow({
        title: t(`configPage.deviceTalk.${key}`),
        checked: voice[key],
        disabled: key === "wakeEnabled" && !voice.supported && !voice.wakeEnabled,
        description:
          key === "wakeEnabled" && !voice.supported
            ? t("configPage.deviceTalk.unsupported")
            : key === "realtimeRelayEnabled"
              ? t("configPage.deviceTalk.realtimeRelayHint")
              : undefined,
        onChange: (value) => capability.set(`voice.${key}`, value),
      }),
    ),
    renderSettingsSelectRow({
      title: t("configPage.deviceTalk.microphone"),
      value: voice.microphone.selectedId ?? "",
      options: microphoneOptions,
      onChange: (value) => capability.set("voice.microphone", value || null),
    }),
    renderSettingsSelectRow({
      title: t("configPage.deviceTalk.primaryLanguage"),
      value: locale.primary,
      options: languageOptions,
      onChange: (value) => {
        const current = deviceLocaleSelection(capability);
        if (current) {
          changeDeviceLocales(capability, {
            primary: value,
            ...(current.additional.includes(value)
              ? { additional: current.additional.filter((id) => id !== value) }
              : {}),
          });
        }
      },
    }),
    renderSettingsRow({
      title: t("configPage.deviceTalk.additionalLanguages"),
      stacked: true,
      control: html`
        ${locale.additional.map((id) => {
          const name = voice.locale.available.find((option) => option.id === id)?.name ?? id;
          return html`<div>
            ${name}
            <button
              class="btn btn--sm"
              type="button"
              aria-label=${t("configPage.deviceTalk.removeLanguage", { name })}
              @click=${() => {
                const current = deviceLocaleSelection(capability);
                if (current) {
                  changeDeviceLocales(capability, {
                    additional: current.additional.filter((value) => value !== id),
                  });
                }
              }}
            >
              ${t("common.remove")}
            </button>
          </div>`;
        })}
        <select
          class="settings-select"
          aria-label=${t("configPage.deviceTalk.addLanguage")}
          @change=${(event: Event) => {
            // SAFETY: This listener is bound directly to the native select, so currentTarget is that select.
            const select = event.currentTarget as HTMLSelectElement;
            const current = deviceLocaleSelection(capability);
            if (
              select.value &&
              current &&
              select.value !== current.primary &&
              !current.additional.includes(select.value)
            ) {
              changeDeviceLocales(capability, {
                additional: [...current.additional, select.value],
              });
              select.value = "";
            }
          }}
        >
          <option value="">${t("configPage.deviceTalk.addLanguage")}</option>
          ${languageOptions
            .filter(({ value }) => value !== locale.primary && !locale.additional.includes(value))
            .map(({ value, label }) => html`<option value=${value}>${label}</option>`)}
        </select>
      `,
    }),
    renderSettingsRow({
      title: t("configPage.deviceTalk.microphoneTest"),
      control: html`<button
        class="btn btn--sm"
        type="button"
        @click=${() => capability.openPanel("microphone-test")}
      >
        ${t("configPage.deviceTalk.microphoneTest")}
      </button>`,
    }),
  ]);
}
