import { html, nothing, type TemplateResult } from "lit";
import {
  TEXT_SCALE_STOPS,
  UI_APPEARANCE_DEFAULTS,
  type TextScaleStop,
} from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeName } from "../../app/theme.ts";
import { icons } from "../../components/icons.ts";
import {
  renderDocsLink,
  renderSettingsDefaultState,
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./settings-targets.ts";
import {
  renderChatPreferencesSection,
  renderLanguageSection,
  renderLobsterPetSection,
  serverUiPrefProvenanceHint,
  renderSidebarPreferencesSection,
} from "./view-appearance-preferences.ts";
import type { ConfigProps } from "./view-types.ts";

const APPEARANCE_DOCS_URL = "https://docs.openclaw.ai/web/control-ui";

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
];

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
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    input.focus();
    input.select();
  });
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
  const themeDefaultState = renderSettingsDefaultState({
    value:
      themeOptions.find((option) => option.id === props.themeResetValue)?.label ??
      t("configView.themes.claw.label"),
    overridden: props.themeOverridden,
    onReset: props.resetTheme,
  });
  const themeModeDefaultState = renderSettingsDefaultState({
    value:
      props.themeModeResetValue === "light"
        ? t("common.light")
        : props.themeModeResetValue === "dark"
          ? t("common.dark")
          : t("common.system"),
    overridden: props.themeModeOverridden,
    onReset: props.resetThemeMode,
  });
  const themeProvenance = serverUiPrefProvenanceHint(props.themeProvenance);
  const themeModeProvenance = serverUiPrefProvenanceHint(props.themeModeProvenance);
  const textScaleDefaultState = renderSettingsDefaultState({
    value: `${UI_APPEARANCE_DEFAULTS.textScale}%`,
    overridden: props.textScaleOverridden,
    onReset: props.resetTextScale,
  });
  return html`
    <div class="settings-page">
      <p class="settings-page__intro">
        ${t("configView.appearance.intro")}
        ${renderDocsLink(APPEARANCE_DOCS_URL, t("common.learnMore"))}
      </p>
      ${renderLanguageSection(props)}
      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.theme")}</h2>
          <div class="settings-section__actions">${themeDefaultState.action}</div>
        </div>
        <p class="settings-section__desc">
          ${t("configView.appearance.chooseTheme")} ${themeDefaultState.description}
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
                      if (opt.id !== props.theme) {
                        const context: ThemeTransitionContext = {
                          element: (e.currentTarget as HTMLElement) ?? undefined,
                        };
                        props.setTheme(opt.id, context);
                      }
                    }}
                  >
                    ${renderThemeCardVisual(opt.id, props.theme)}
                    <span class="settings-theme-card__label">${opt.label}</span>
                    ${opt.id === props.theme
                      ? html`<span class="settings-theme-card__check" aria-hidden="true"
                          >${icons.check}</span
                        >`
                      : nothing}
                  </button>
                `,
              )}
            </div>
          </div>
          ${renderSettingsRow({
            title: t("common.colorMode"),
            description: html`${themeModeDefaultState.description} ${themeModeProvenance}`,
            stacked: true,
            control: html`
              ${themeModeDefaultState.action}
              ${renderSettingsSegmented({
                value: props.themeMode,
                options: [
                  { value: "system", label: t("common.system") },
                  { value: "light", label: t("common.light") },
                  { value: "dark", label: t("common.dark") },
                ],
                ariaLabel: t("common.colorMode"),
                onChange: (mode, element) => props.setThemeMode(mode, { element }),
              })}
            `,
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

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.textSize} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.textSize")}</h2>
          <div class="settings-section__actions">${textScaleDefaultState.action}</div>
        </div>
        <p class="settings-section__desc">
          ${textScaleDefaultState.description} ${t("quickSettings.personal.browserOnly")}
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
