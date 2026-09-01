import { html, nothing, type TemplateResult } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { controlUiAccentInk } from "../../app/accent-contrast.ts";
import {
  TEXT_SCALE_STOPS,
  UI_APPEARANCE_DEFAULTS,
  type TextScaleStop,
} from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeName } from "../../app/theme.ts";
import {
  loadTypefaceSpecimens,
  normalizeTypefaceOverride,
  THEME_TYPEFACES,
  TYPEFACES,
} from "../../app/typography.ts";
import { icons } from "../../components/icons.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import {
  renderChatPreferencesSection,
  renderLanguageSection,
  renderLobsterPetSection,
  serverUiPrefProvenanceHint,
  renderSidebarPreferencesSection,
} from "./view-appearance-preferences.ts";
import type { ConfigProps } from "./view-types.ts";

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};

type ThemeOption = {
  id: ThemeName;
  labelKey: string;
  descriptionKey: string;
};

const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  {
    id: "claw",
    labelKey: "configView.themes.claw.label",
    descriptionKey: "configView.themes.claw.description",
  },
  {
    id: "knot",
    labelKey: "configView.themes.knot.label",
    descriptionKey: "configView.themes.knot.description",
  },
  {
    id: "dash",
    labelKey: "configView.themes.dash.label",
    descriptionKey: "configView.themes.dash.description",
  },
  {
    id: "absolutely",
    labelKey: "configView.themes.absolutely.label",
    descriptionKey: "configView.themes.absolutely.description",
  },
  {
    id: "tide",
    labelKey: "configView.themes.tide.label",
    descriptionKey: "configView.themes.tide.description",
  },
  {
    id: "beacon",
    labelKey: "configView.themes.beacon.label",
    descriptionKey: "configView.themes.beacon.description",
  },
  {
    id: "phosphor",
    labelKey: "configView.themes.phosphor.label",
    descriptionKey: "configView.themes.phosphor.description",
  },
  {
    id: "crt",
    labelKey: "configView.themes.crt.label",
    descriptionKey: "configView.themes.crt.description",
  },
  {
    id: "manuscript",
    labelKey: "configView.themes.manuscript.label",
    descriptionKey: "configView.themes.manuscript.description",
  },
  {
    id: "rose",
    labelKey: "configView.themes.rose.label",
    descriptionKey: "configView.themes.rose.description",
  },
  {
    id: "miami",
    labelKey: "configView.themes.miami.label",
    descriptionKey: "configView.themes.miami.description",
  },
];

const ACCENT_PRESETS = [
  { id: "default", hex: undefined, labelKey: "configView.appearance.accents.default" },
  { id: "claw", hex: "#ff5c5c", labelKey: "configView.appearance.accents.claw" },
  { id: "coral", hex: "#ff8066", labelKey: "configView.appearance.accents.coral" },
  { id: "amber", hex: "#f5b942", labelKey: "configView.appearance.accents.amber" },
  { id: "mint", hex: "#52c99a", labelKey: "configView.appearance.accents.mint" },
  { id: "teal", hex: "#35b9b0", labelKey: "configView.appearance.accents.teal" },
  { id: "blue", hex: "#5b9cf6", labelKey: "configView.appearance.accents.blue" },
  { id: "violet", hex: "#a78bfa", labelKey: "configView.appearance.accents.violet" },
  { id: "pink", hex: "#f472b6", labelKey: "configView.appearance.accents.pink" },
  { id: "slate", hex: "#8795a8", labelKey: "configView.appearance.accents.slate" },
] as const;

/* Builtin cards preview their real palette (chip colors live in config.css,
   mirrored from the base.css theme blocks). The custom card only has real
   colors while active — its chips read the live CSS variables — so it falls
   back to the spark icon otherwise. */
function renderThemeCardVisual(id: ThemeName, activeTheme: ThemeName) {
  if (id === "custom" && activeTheme !== "custom") {
    return html`<span class="settings-theme-card__icon" aria-hidden="true"
      >${icons.download}</span
    >`;
  }
  return html`
    <span class="settings-theme-card__palette" aria-hidden="true">
      <span class="settings-theme-card__chip settings-theme-card__chip--accent"></span>
      <span class="settings-theme-card__chip settings-theme-card__chip--accent-2"></span>
      <span class="settings-theme-card__chip settings-theme-card__chip--bg"></span>
    </span>
  `;
}

function importedThemeName(props: Pick<ConfigProps, "hasCustomTheme" | "customThemeLabel">) {
  return props.hasCustomTheme && props.customThemeLabel
    ? props.customThemeLabel
    : t("configView.appearance.importedTheme");
}

function focusCustomThemeImportInput() {
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
  schedule(() => {
    const input = globalThis.document?.querySelector<HTMLInputElement>(
      "[data-custom-theme-import-input]",
    );
    if (!input) {
      return;
    }
    if (typeof input.scrollIntoView === "function") {
      input.scrollIntoView({ block: "center", behavior: resolveScrollBehavior() });
    }
    input.focus();
    input.select();
  });
}

function renderTypography(props: ConfigProps, themeLabel: string) {
  const options = Object.entries(TYPEFACES).map(([face, metadata]) => ({
    value: face,
    label: face === "system" ? t("configView.appearance.fonts.system") : metadata.label,
    description: t(`configView.appearance.fontNotes.${face}`),
    labelStyle: `font-family: ${metadata.stack}`,
  }));
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.typography")}</h2>
      </div>
      <div class="settings-group">
        ${(["ui", "chat"] as const).map((slot) => {
          const isUi = slot === "ui";
          const title = t(`configView.appearance.fonts.${slot}`);
          const face = THEME_TYPEFACES[props.theme][slot];
          return renderSettingsRow({
            title,
            description: serverUiPrefProvenanceHint(
              isUi ? props.fontUiProvenance : props.fontChatProvenance,
            ),
            stackedOnNarrow: true,
            control: renderPicker({
              id: `settings-font-${slot}`,
              label: title,
              value: (isUi ? props.fontUi : props.fontChat) ?? "theme",
              options: [
                {
                  value: "theme",
                  // Both slots say "Theme default": Dash and Absolutely default
                  // chat to a serif that intentionally differs from the interface
                  // face, so "match interface" would misname the actual fallback.
                  label: t("configView.appearance.fonts.themeDefault"),
                  description: t("configView.appearance.fonts.themeFace", {
                    theme: themeLabel,
                    face: TYPEFACES[face].label,
                  }),
                  labelStyle: `font-family: ${TYPEFACES[face].stack}`,
                },
                ...options,
              ],
              onOpen: loadTypefaceSpecimens,
              onChange: (value) =>
                (isUi ? props.setFontUi : props.setFontChat)(normalizeTypefaceOverride(value)),
            }),
          });
        })}
        <div class="settings-row settings-row--stacked">
          <div class="settings-typography-preview">
            <div class="settings-typography-preview__caption">
              ${t("configView.appearance.fonts.previewCaption")}
            </div>
            <p class="settings-typography-preview__prose">
              ${t("configView.appearance.fonts.previewProse")}
            </p>
            <code class="settings-typography-preview__code"
              >${t("configView.appearance.fonts.previewCode")}</code
            >
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderAppearanceSection(
  props: ConfigProps,
  inputs: { customThemeImport: TemplateResult; chatMessageWidth: TemplateResult },
) {
  const viewState = props.viewState;
  const showCustomThemeImport = props.hasCustomTheme || props.customThemeImportExpanded === true;
  if (
    showCustomThemeImport &&
    props.customThemeImportFocusToken != null &&
    props.customThemeImportFocusToken !== viewState.lastCustomThemeImportFocusToken
  ) {
    viewState.lastCustomThemeImportFocusToken = props.customThemeImportFocusToken;
    focusCustomThemeImportInput();
  }
  const importedName = importedThemeName(props);
  const themeOptions: Array<{ id: ThemeName; label: string; description: string }> = [
    ...BUILTIN_THEME_OPTIONS.map((option) => ({
      id: option.id,
      label: t(option.labelKey),
      description: t(option.descriptionKey),
    })),
    {
      id: "custom",
      label: props.hasCustomTheme ? importedName : t("configView.appearance.import"),
      description: props.hasCustomTheme
        ? t("configView.appearance.importedFrom", { name: importedName })
        : t("configView.appearance.importHint"),
    },
  ];
  const themeDefault =
    themeOptions.find((option) => option.id === props.themeResetValue)?.label ??
    t("configView.themes.claw.label");
  const themeModeDefault =
    props.themeModeResetValue === "light"
      ? t("common.light")
      : props.themeModeResetValue === "dark"
        ? t("common.dark")
        : t("common.system");
  const themeProvenance = serverUiPrefProvenanceHint(props.themeProvenance);
  const themeModeProvenance = serverUiPrefProvenanceHint(props.themeModeProvenance);
  const accentProvenance = serverUiPrefProvenanceHint(props.accentProvenance);
  const customAccentSelected = Boolean(
    props.accent && !ACCENT_PRESETS.some((preset) => preset.hex === props.accent),
  );
  const selectedAccentPreset = ACCENT_PRESETS.find((preset) => preset.hex === props.accent);
  const accentSelectionStatus =
    props.accent == null
      ? t("configView.appearance.usingInheritedAccent")
      : t("configView.appearance.usingAccent", {
          value: selectedAccentPreset
            ? t(selectedAccentPreset.labelKey)
            : t("configView.appearance.customAccent"),
        });
  return html`
    <div class="settings-page">
      ${renderLanguageSection(props)}
      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.theme")}</h2>
        </div>
        <p class="settings-section__desc">
          ${t("configView.appearance.chooseTheme")}
          ${renderSettingsDefaultDescription(themeDefault, props.themeOverridden)}
          ${themeProvenance}
        </p>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-theme-grid">
              ${themeOptions.map(
                (opt) => html`
                  <button
                    class="settings-theme-card settings-theme-card--${opt.id} ${opt.id ===
                    props.theme
                      ? "settings-theme-card--active"
                      : ""}"
                    aria-pressed=${opt.id === "custom" && !props.hasCustomTheme
                      ? nothing
                      : String(opt.id === props.theme)}
                    title=${opt.description}
                    @click=${(e: Event) => {
                      if (opt.id === "custom" && !props.hasCustomTheme) {
                        props.onOpenCustomThemeImport?.();
                        return;
                      }
                      if (
                        opt.id !== props.theme ||
                        (opt.id === props.themeResetValue && props.themeOverridden)
                      ) {
                        const context: ThemeTransitionContext = {
                          element: (e.currentTarget as HTMLElement) ?? undefined,
                        };
                        props.setTheme(opt.id, context);
                      }
                    }}
                  >
                    ${renderThemeCardVisual(opt.id, props.theme)}
                    <span class="settings-theme-card__label">${opt.label}</span>
                  </button>
                `,
              )}
            </div>
          </div>
          ${renderSettingsRow({
            title: t("common.colorMode"),
            description: html`${renderSettingsDefaultDescription(
              themeModeDefault,
              props.themeModeOverridden,
            )}
            ${themeModeProvenance}`,
            stackedOnNarrow: true,
            control: renderSettingsSegmented({
              value: props.themeMode,
              options: [
                { value: "system", label: t("common.system") },
                { value: "light", label: t("common.light") },
                { value: "dark", label: t("common.dark") },
              ],
              ariaLabel: t("common.colorMode"),
              onChange: (mode, element) => props.setThemeMode(mode, { element }),
              onReselect: (mode, element) => {
                if (props.themeModeOverridden && mode === props.themeModeResetValue) {
                  props.setThemeMode(mode, { element });
                }
              },
            }),
          })}
          <div class="settings-row settings-row--stacked">
            ${showCustomThemeImport
              ? html`
                  <div class="settings-theme-import">
                    <div class="settings-theme-import__copy">
                      <div class="settings-theme-import__title">
                        ${t("configView.appearance.importFromTweakcn")}
                      </div>
                      <p class="settings-theme-import__hint">
                        ${t("configView.appearance.tweakcnInstructions")}
                      </p>
                    </div>
                    <a
                      class="settings-theme-import__external"
                      href="https://tweakcn.com/editor/theme"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      ${t("configView.appearance.browseTweakcn")} ${icons.externalLink}
                    </a>
                    <label class="settings-theme-import__field">
                      <span class="settings-theme-import__label"
                        >${t("configView.appearance.themeLink")}</span
                      >
                      ${inputs.customThemeImport}
                    </label>
                    <div class="settings-theme-import__actions">
                      <button
                        class="btn btn--sm primary"
                        ?disabled=${props.customThemeImportBusy ||
                        props.customThemeImportUrl.trim().length === 0}
                        @click=${props.onImportCustomTheme}
                      >
                        ${props.customThemeImportBusy
                          ? t("common.importing")
                          : props.hasCustomTheme
                            ? t("configView.appearance.replace", { name: importedName })
                            : t("configView.appearance.importTheme")}
                      </button>
                      ${props.hasCustomTheme
                        ? html`<button
                            class="btn btn--sm danger"
                            @click=${props.onClearCustomTheme}
                          >
                            ${t("configView.appearance.clear", { name: importedName })}
                          </button>`
                        : nothing}
                    </div>
                    ${props.hasCustomTheme
                      ? html`<div class="settings-theme-import__meta">
                          <span class="settings-theme-import__meta-label"
                            >${t("configView.appearance.loaded")}</span
                          >
                          <span class="settings-theme-import__meta-value"
                            >${importedName} · ${props.customThemeSourceUrl ?? "tweakcn"}</span
                          >
                        </div>`
                      : nothing}
                    ${props.customThemeImportMessage
                      ? html`<div
                          class="settings-theme-import__message settings-theme-import__message--${props
                            .customThemeImportMessage.kind}"
                          role=${props.customThemeImportMessage.kind === "error"
                            ? "alert"
                            : "status"}
                        >
                          ${props.customThemeImportMessage.text}
                        </div>`
                      : nothing}
                  </div>
                `
              : html`<p class="settings-theme-import__inline-hint">
                  ${t("configView.appearance.inlineHintBefore")}
                  <strong>${t("configView.appearance.import")}</strong>
                  ${t("configView.appearance.inlineHintAfter")}
                </p>`}
          </div>
        </div>
      </section>

      ${renderTypography(props, themeOptions.find((option) => option.id === props.theme)!.label)}

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.accent} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.accent")}</h2>
        </div>
        <p class="settings-section__desc">${t("configView.appearance.accentHint")}</p>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-accent-swatches">
              ${ACCENT_PRESETS.map((preset) => {
                const selected = preset.hex === props.accent;
                const label = t(preset.labelKey);
                // The default swatch previews the active theme's own accent via the
                // theme-invariant chip vars; bare var(--accent) would show the live
                // override and render as a duplicate of the selected preset. Uses a
                // swatch-scoped class so theme-card locators stay unique.
                const themeChipScope = preset.hex ? "" : ` settings-accent-theme--${props.theme}`;
                return html`
                  <button
                    type="button"
                    class="settings-accent-swatch${themeChipScope} ${selected
                      ? "settings-accent-swatch--active"
                      : ""}"
                    style=${styleMap({
                      "--settings-accent-swatch":
                        preset.hex ?? "var(--theme-chip-accent, var(--accent))",
                    })}
                    data-accent-preset=${preset.id}
                    aria-label=${label}
                    aria-pressed=${String(selected)}
                    title=${label}
                    @click=${() => props.setAccent(preset.hex)}
                  >
                    ${selected
                      ? html`<span class="settings-accent-swatch__check" aria-hidden="true"
                          >${icons.check}</span
                        >`
                      : nothing}
                  </button>
                `;
              })}
              <span
                class="settings-accent-swatch settings-accent-swatch--custom ${customAccentSelected
                  ? "settings-accent-swatch--active"
                  : ""}"
                style=${styleMap({
                  "--settings-accent-swatch": props.accent ?? ACCENT_PRESETS[1].hex,
                  "--settings-accent-swatch-ink": controlUiAccentInk(
                    props.accent ?? ACCENT_PRESETS[1].hex,
                  ),
                })}
              >
                <input
                  type="color"
                  class="settings-accent-swatch__input"
                  data-accent-custom
                  aria-label=${t("configView.appearance.customAccent")}
                  aria-describedby="settings-accent-status"
                  title=${t("configView.appearance.customAccent")}
                  .value=${props.accent ?? ACCENT_PRESETS[1].hex}
                  @input=${(event: Event & { currentTarget: HTMLInputElement }) =>
                    props.setAccent(event.currentTarget.value)}
                />
                <span class="settings-accent-swatch__picker" aria-hidden="true"
                  >${icons.pipette}</span
                >
              </span>
            </div>
          </div>
        </div>
        <p id="settings-accent-status" class="settings-section__desc settings-accent-status">
          <span class="settings-accent-status__selection">${accentSelectionStatus}</span>
          <span class="settings-accent-status__scope">${accentProvenance}</span>
        </p>
      </section>

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.textSize} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.textSize")}</h2>
        </div>
        <p class="settings-section__desc">
          ${renderSettingsDefaultDescription(
            `${UI_APPEARANCE_DEFAULTS.textScale}%`,
            props.textScaleOverridden,
          )}
          ${t("quickSettings.personal.browserOnly")}
        </p>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-text-scale">
              <div class="settings-text-scale__options">
                ${TEXT_SCALE_STOPS.map(
                  (stop) => html`
                    <button
                      type="button"
                      class="settings-text-scale__btn ${stop === props.textScale ? "active" : ""}"
                      aria-pressed=${String(stop === props.textScale)}
                      @click=${() => props.setTextScale(stop)}
                    >
                      <span class="settings-text-scale__sample">${t(TEXT_SCALE_LABELS[stop])}</span>
                      <span class="settings-text-scale__label">${stop}%</span>
                    </button>
                  `,
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      ${renderSidebarPreferencesSection(props)} ${renderLobsterPetSection(props)}
      ${renderChatPreferencesSection(props, inputs.chatMessageWidth)}

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.connection} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.connection.title")}</h2>
        </div>
        <div class="settings-group">
          ${renderSettingsRow({
            title: t("configView.connection.gateway"),
            control: renderSettingsValue(props.gatewayUrl || "-", { mono: true }),
          })}
          ${renderSettingsRow({
            title: t("configView.connection.status"),
            control: renderSettingsStatus({
              kind: props.connected ? "ok" : "muted",
              label: props.connected ? t("common.connected") : t("common.offline"),
            }),
          })}
          ${props.assistantName
            ? renderSettingsRow({
                title: t("configView.connection.assistant"),
                control: renderSettingsValue(props.assistantName),
              })
            : nothing}
        </div>
      </section>
    </div>
  `;
}
