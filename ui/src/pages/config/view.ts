// Control UI view renders config screen content.
import "../../styles/lobster-pet.css";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { normalizeChatMessageMaxWidth } from "../../app/settings.ts";
import { countSensitiveConfigValues } from "../../components/config-form.shared.ts";
import { renderConfigForm } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import "../../components/tooltip.ts";
import { icons } from "../../components/icons.ts";
import { highlightJsonHtml } from "../../components/markdown-code-blocks.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { isJson5Warm, warmJson5 } from "../../lib/json5-runtime.ts";
import { renderNotificationsSection } from "./notifications-section.ts";
import { renderSetupSection } from "./setup.ts";
import { renderAppearanceSection } from "./view-appearance.ts";
import { computeRawDiff, formatConfigDiffPath, renderRawDiffValue } from "./view-diff.ts";
import {
  CATEGORISED_KEYS,
  getChannelConfigGroups,
  renderConfigAccordionNav,
  SECTION_CATEGORIES,
  type SectionCategory,
} from "./view-navigation.ts";
import {
  asConfigSchema,
  configValueExistsAtPath,
  getConfigSchemaAnalysis,
  renderUnsupportedPathSummary,
} from "./view-schema.ts";
import {
  configContextKey,
  isSensitivePathRevealed,
  resetConfigEphemeralState,
  toggleSensitivePathReveal,
} from "./view-state.ts";
import type { ConfigProps } from "./view-types.ts";

registerSettingsEnglish();

export { createConfigViewState } from "./view-state.ts";
export type { ConfigProps, ConfigViewState } from "./view-types.ts";

// The config editor is where JSON5 text first appears; warm the parser with
// the page instead of racing the first raw-draft keystroke.
void warmJson5().catch(() => undefined);

function renderAppearance(props: ConfigProps) {
  return renderAppearanceSection(props, {
    chatMessageWidth: html`
      <input
        class="settings-input"
        data-settings-chat-message-width
        type="text"
        spellcheck="false"
        placeholder="48rem"
        .value=${props.chatMessageMaxWidth ?? ""}
        @change=${(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const normalized = normalizeChatMessageMaxWidth(input.value);
          if (input.value.trim() && !normalized) {
            input.setCustomValidity(t("configView.chatPrefs.messageWidthInvalid"));
            input.reportValidity();
            return;
          }
          input.setCustomValidity("");
          input.value = normalized ?? "";
          props.setChatMessageMaxWidth(normalized);
        }}
      />
    `,
    customThemeImport: html`
      <input
        class="settings-theme-import__input"
        data-custom-theme-import-input
        type="text"
        spellcheck="false"
        placeholder="https://tweakcn.com/editor/theme?theme=... or amethyst-haze"
        .value=${props.customThemeImportUrl}
        @input=${(event: Event) =>
          props.onCustomThemeImportUrlChange((event.currentTarget as HTMLInputElement).value)}
      />
    `,
  });
}

export function renderConfig(props: ConfigProps) {
  const renderSection = props.renderSection ?? ((editor) => editor);
  const viewState = props.viewState;
  const showModeToggle = props.showModeToggle ?? false;
  const showRootTab = props.showRootTab ?? true;
  const validity = props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const includeVirtualSections = props.includeVirtualSections ?? true;
  const include = props.includeSections?.length ? new Set(props.includeSections) : null;
  const exclude = props.excludeSections?.length ? new Set(props.excludeSections) : null;
  const analysis = getConfigSchemaAnalysis(
    viewState,
    asConfigSchema(props.schema),
    props.includeSections,
    props.excludeSections,
    include,
    exclude,
  );
  const unsupportedActivePaths = analysis.unsupportedPaths.filter(
    (path) =>
      path !== "<root>" &&
      (!props.activeSection ||
        path === props.activeSection ||
        path.startsWith(`${props.activeSection}.`)) &&
      configValueExistsAtPath(props.formValue, path),
  );
  const formUnsafe = unsupportedActivePaths.length > 0;
  const effectiveShowAdvanced = props.forceShowAdvanced === true || props.showAdvancedSettings;
  const rawAvailable = props.rawAvailable ?? true;
  // An unsaved raw draft stays authoritative in the capability; hiding the
  // raw editor would show a stale form beside an apply that always refuses.
  // Pin the raw view until the draft is saved or discarded.
  const rawDraftPending = Boolean(props.rawDraftPending) && rawAvailable;
  const displayFormMode = showModeToggle && rawAvailable ? props.formMode : "form";
  const formMode = rawDraftPending ? "raw" : displayFormMode;
  const requestUpdate = props.onViewStateChange;
  // Scroll helper: target-based (nav clicks) with global fallback (form/raw toggle)
  const resetContentScroll = (target: EventTarget | null) => {
    queueMicrotask(() => {
      // Flat layout: the settings shell owns the scroll viewport; the sibling
      // .config-content lookup covers embedded/detached hosts.
      const origin = target instanceof Element ? target : null;
      const scrollTargets = [
        origin
          ?.closest(".config-lead")
          ?.parentElement?.querySelector<HTMLElement>(".config-content") ??
          globalThis.document?.querySelector<HTMLElement>(".config-content"),
        globalThis.document?.querySelector<HTMLElement>(".shell--settings .content"),
      ];
      for (const content of scrollTargets) {
        if (!content) {
          continue;
        }
        if (typeof content.scrollTo === "function") {
          content.scrollTo({ top: 0, left: 0, behavior: "auto" });
        } else {
          content.scrollTop = 0;
          content.scrollLeft = 0;
        }
      }
    });
  };

  // Reset scroll position when switching between form and raw mode
  if (viewState.lastFormModeForScroll !== null && viewState.lastFormModeForScroll !== formMode) {
    resetContentScroll(null);
  }
  viewState.lastFormModeForScroll = formMode;

  const currentContextKey = configContextKey(props);
  if (viewState.lastConfigContextKey !== currentContextKey) {
    resetConfigEphemeralState(viewState);
    viewState.lastConfigContextKey = currentContextKey;
  }
  const envSensitiveVisible = viewState.envRevealed;

  // Build categorised nav from schema - only include sections that exist in the schema
  const schemaProps = analysis.schema?.properties ?? {};
  const VIRTUAL_SECTIONS = new Set(["__appearance__", "__notifications__"]);
  const isVisibleVirtualSection = (key: string) =>
    includeVirtualSections &&
    VIRTUAL_SECTIONS.has(key) &&
    (key === "__appearance__" || include?.has(key) === true);
  const resolveNavSectionLabel = (key: string) => {
    const sectionKey =
      key === "__appearance__" ? "theme" : key === "__notifications__" ? "notifications" : key;
    return t(`configView.sections.${sectionKey}`);
  };
  const visibleCategories: SectionCategory[] = SECTION_CATEGORIES.map((category) => ({
    id: category.id,
    label: t(`configView.categories.${category.id}`),
    sections: category.sections
      .filter(
        (key) =>
          (isVisibleVirtualSection(key) || key in schemaProps) &&
          (!include || include.has(key)) &&
          (!exclude || !exclude.has(key)),
      )
      .map((key) => ({ key, label: resolveNavSectionLabel(key) })),
  })).filter((category) => category.sections.length > 0);

  // Catch any schema keys not in our categories
  const extraSections = Object.keys(schemaProps)
    .filter((key) => !CATEGORISED_KEYS.has(key))
    .map((key) => ({ key, label: key.charAt(0).toUpperCase() + key.slice(1) }));
  const otherCategory: SectionCategory | null =
    extraSections.length > 0
      ? { id: "other", label: t("configView.categories.other"), sections: extraSections }
      : null;

  const channelSchema = props.activeSection === "channels" ? schemaProps.channels : undefined;
  const channelGroups = channelSchema ? getChannelConfigGroups(channelSchema, props.uiHints) : [];
  const channelGroup =
    channelGroups.find((group) => group.key === props.activeSubsection) ?? channelGroups[0];
  // Keep the original field paths and values: Other is navigation, not a config namespace.
  const formSchema =
    channelSchema && channelGroup
      ? {
          ...analysis.schema,
          properties: {
            ...schemaProps,
            channels: {
              ...channelSchema,
              properties: Object.fromEntries(
                Object.entries(channelSchema.properties ?? {}).filter(([key]) =>
                  channelGroup.keys.includes(key),
                ),
              ),
              required: channelSchema.required?.filter((key) => channelGroup.keys.includes(key)),
              additionalProperties: false,
            },
          },
        }
      : analysis.schema;
  const setupSchema = formSchema?.properties?.wizard;
  const showSetup = setupSchema && (!props.activeSection || props.activeSection === "wizard");
  const editorSchema = setupSchema
    ? {
        ...formSchema,
        properties: Object.fromEntries(
          Object.entries(formSchema.properties ?? {}).filter(([key]) => key !== "wizard"),
        ),
      }
    : formSchema;
  const topTabs = [
    ...(showRootTab
      ? [{ key: null as string | null, label: props.navRootLabel ?? t("nav.settings") }]
      : []),
    ...[...visibleCategories, ...(otherCategory ? [otherCategory] : [])].flatMap((category) =>
      category.sections.map((section) => ({ key: section.key, label: section.label })),
    ),
  ];
  const settingsLayout = props.settingsLayout ?? "tabs";
  const allCategories = [...visibleCategories, ...(otherCategory ? [otherCategory] : [])];

  // Raw mode keeps an explicit diff + save flow; form edits auto-save.
  const hasRawChanges = formMode === "raw" && props.raw !== props.originalRaw;
  if ((!hasRawChanges || formMode !== "raw") && viewState.rawDiffOpen) {
    viewState.rawDiffOpen = false;
  }
  if (!hasRawChanges || formMode !== "raw" || !viewState.rawDiffOpen) {
    viewState.rawDiffCache = undefined;
  }
  const rawDiff =
    formMode === "raw" && hasRawChanges && viewState.rawDiffOpen
      ? computeRawDiff(viewState, props.originalRaw, props.raw)
      : [];
  if (formMode === "raw" && hasRawChanges && viewState.rawDiffOpen && !isJson5Warm()) {
    // First diff open can race the lazy JSON5 parser; re-render when it lands
    // so the pending-changes list fills in instead of staying empty.
    void warmJson5()
      .then(() => requestUpdate())
      .catch(() => undefined);
  }
  // Includes the app updater: writes are suspended while it runs, so raw
  // Save/Discard must read busy instead of silently no-opping.
  const configBusy = props.loading || props.saving || props.applying || props.updating;
  const mutationAllowed = props.mutationAllowed !== false;
  const canRawSave = props.connected && mutationAllowed && !configBusy && hasRawChanges;
  const showAppearanceOnRoot =
    includeVirtualSections &&
    formMode === "form" &&
    props.activeSection === null &&
    Boolean(include?.has("__appearance__"));

  const rawDiffPanel =
    hasRawChanges && formMode === "raw"
      ? html`<details
          class="config-diff"
          ?open=${viewState.rawDiffOpen}
          @toggle=${(event: Event) => {
            const details = event.target as HTMLDetailsElement;
            if (viewState.rawDiffOpen === details.open) {
              return;
            }
            viewState.rawDiffOpen = details.open;
            if (!details.open) {
              viewState.rawDiffCache = undefined;
            }
            requestUpdate();
          }}
        >
          <summary class="config-diff__summary">
            <span>${t("configView.viewPendingChangesRaw")}</span>
            <svg
              class="config-diff__chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </summary>
          <div class="config-diff__content">
            ${
              rawDiff.length > 0
                ? rawDiff.map(
                    (change) => html`<div class="config-diff__item">
                      <div class="config-diff__path">${formatConfigDiffPath(change.path)}</div>
                      <div class="config-diff__values">
                        <span class="config-diff__from"
                          >${renderRawDiffValue(
                            change.path,
                            change.from,
                            props.uiHints,
                            viewState.rawRevealed,
                          )}</span
                        >
                        <span class="config-diff__arrow">→</span>
                        <span class="config-diff__to"
                          >${renderRawDiffValue(
                            change.path,
                            change.to,
                            props.uiHints,
                            viewState.rawRevealed,
                          )}</span
                        >
                      </div>
                    </div>`,
                  )
                : html`<div class="config-diff__item">${t("configView.rawDiffUnavailable")}</div>`
            }
          </div>
        </details>`
      : nothing;

  const showSectionTabs = settingsLayout !== "accordion" && topTabs.length > 1;
  const sectionTabs = showSectionTabs
    ? renderHubTabs({
        id: "config-sections",
        active: props.activeSection ?? "root",
        tabs: topTabs.map((tab) => ({ value: tab.key ?? "root", label: tab.label })),
        ariaLabel: t("common.settingsSections"),
        panelId: "config-section-panel",
        onSelect: (value) => props.onSectionChange(value === "root" ? null : value),
        onActivate: resetContentScroll,
      })
    : nothing;
  const showToolbar = showModeToggle || showSectionTabs;
  const showValidityWarning = validity === "invalid" && !viewState.validityDismissed;
  const showLead =
    showToolbar || settingsLayout === "accordion" || showValidityWarning || Boolean(channelGroup);

  const lead = html`<div class="config-lead">
    ${
      showToolbar
        ? html`<div class="config-toolbar">
            ${
              showModeToggle
                ? html`<div class="config-mode-toggle">
                    <button
                      class="config-mode-toggle__btn ${formMode === "form" ? "active" : ""}"
                      aria-pressed=${formMode === "form" ? "true" : "false"}
                      ?disabled=${props.schemaLoading || !props.schema || rawDraftPending}
                      title=${
                        rawDraftPending
                          ? t("configView.rawDraftPendingFormTitle")
                          : formUnsafe
                            ? t("configView.formUnsafeTitle")
                            : ""
                      }
                      @click=${() => props.onFormModeChange("form")}
                    >
                      ${t("configView.form")}
                    </button>
                    <button
                      class="config-mode-toggle__btn ${formMode === "raw" ? "active" : ""}"
                      aria-pressed=${formMode === "raw" ? "true" : "false"}
                      ?disabled=${!rawAvailable}
                      title=${
                        rawAvailable
                          ? t("configView.rawTitle")
                          : t("configView.rawUnavailableTitle")
                      }
                      @click=${() => props.onFormModeChange("raw")}
                    >
                      ${t("configView.raw")}
                    </button>
                  </div>`
                : nothing
            }
            ${sectionTabs}
          </div>`
        : nothing
    }
    ${settingsLayout === "accordion" ? renderConfigAccordionNav(props, allCategories, resetContentScroll) : nothing}
    ${
      channelGroup && formMode === "form"
        ? html`<div class="config-toolbar">
            <label class="field">
              <span>${t("configView.channelSettings")}</span>
              <select
                class="settings-select"
                .value=${channelGroup.key ?? ""}
                @change=${(event: Event) => {
                  // SAFETY: This handler is bound directly to the native select above.
                  const select = event.currentTarget as HTMLSelectElement;
                  props.onSubsectionChange(select.value || null);
                  resetContentScroll(event.currentTarget);
                }}
              >
                ${channelGroups.map(
                  (group) =>
                    html`<option
                      value=${group.key ?? ""}
                      ?selected=${group.key === channelGroup.key}
                    >
                      ${group.label}
                    </option>`,
                )}
              </select>
            </label>
          </div>`
        : nothing
    }
    ${
      showValidityWarning
        ? html`<div class="config-validity-warning">
            <svg
              class="config-validity-warning__icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              width="16"
              height="16"
            >
              <path
                d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
              ></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span class="config-validity-warning__text">${t("configView.invalidConfig")}</span>
            <button
              class="btn btn--sm"
              @click=${() => {
                viewState.validityDismissed = true;
                requestUpdate();
              }}
            >
              ${t("configView.dismissWarning")}
            </button>
          </div>`
        : nothing
    }
  </div>`;

  return html`
    ${showLead ? lead : nothing}
    <div
      id="config-section-panel"
      class="config-content"
      role=${showSectionTabs ? "tabpanel" : "region"}
      aria-labelledby=${
        showSectionTabs ? `config-sections-tab-${props.activeSection ?? "root"}` : nothing
      }
      aria-label=${showSectionTabs ? nothing : t("common.settingsSections")}
    >
      ${
        props.activeSection === "__appearance__"
          ? includeVirtualSections
            ? renderAppearance(props)
            : nothing
          : props.activeSection === "__notifications__"
            ? includeVirtualSections
              ? renderNotificationsSection(props)
              : nothing
            : formMode === "form"
              ? html`
                  ${
                    formUnsafe && showModeToggle && rawAvailable
                      ? html`<div class="config-content-callout">
                          <div class="callout info">
                            ${renderUnsupportedPathSummary(unsupportedActivePaths)}
                            <button
                              type="button"
                              class="btn btn--sm"
                              @click=${() => props.onFormModeChange("raw")}
                            >
                              ${t("configView.openRawEditor")}
                            </button>
                          </div>
                        </div>`
                      : nothing
                  }
                  ${showAppearanceOnRoot ? renderAppearance(props) : nothing}
                  ${
                    props.schemaLoading
                      ? html`<div class="config-loading">
                          <div class="config-loading__spinner"></div>
                          <span>${t("configView.loadingSchema")}</span>
                        </div>`
                      : renderSection(
                          renderConfigForm({
                            schema: editorSchema,
                            uiHints: props.uiHints,
                            value: props.formValue,
                            embedded: props.embeddedEditor === true || Boolean(showSetup),
                            rawAvailable,
                            disabled: configBusy || !props.formValue || !mutationAllowed,
                            unsupportedPaths: analysis.unsupportedPaths,
                            onPatch: props.onFormPatch,
                            onRemove: props.onFormRemove,
                            activeSection: props.activeSection,
                            activeSubsection: null,
                            showAdvanced: effectiveShowAdvanced,
                            forceAdvancedSection: props.forceAdvancedSection,
                            onShowAdvanced: () => props.setShowAdvancedSettings(true),
                            onHideAdvanced: props.forceShowAdvanced
                              ? undefined
                              : () => props.setShowAdvancedSettings(false),
                            sectionActions:
                              props.activeSection === "env"
                                ? html`<button
                                    class="btn btn--sm ${envSensitiveVisible ? "active" : ""}"
                                    aria-pressed=${envSensitiveVisible ? "true" : "false"}
                                    title=${
                                      envSensitiveVisible
                                        ? t("configView.hideEnvValues")
                                        : t("configView.revealEnvValues")
                                    }
                                    @click=${() => {
                                      viewState.envRevealed = !viewState.envRevealed;
                                      requestUpdate();
                                    }}
                                  >
                                    ${envSensitiveVisible ? icons.eyeOff : icons.eye}
                                    ${t("configView.peek")}
                                  </button>`
                                : undefined,
                            showSectionDocs: props.showSectionDocs,
                            sectionPrelude: props.sectionPrelude,
                            revealSensitive:
                              props.activeSection === "env" ? envSensitiveVisible : false,
                            isSensitivePathRevealed: (path) =>
                              isSensitivePathRevealed(viewState, path),
                            onToggleSensitivePath: (path) => {
                              toggleSensitivePathReveal(viewState, path);
                              requestUpdate();
                            },
                          }),
                        )
                  }
                  ${
                    showSetup && !props.schemaLoading
                      ? renderSetupSection(
                          setupSchema,
                          props,
                          configBusy || !props.formValue || !mutationAllowed,
                        )
                      : nothing
                  }
                `
              : (() => {
                  const sensitiveCount = countSensitiveConfigValues(
                    props.formValue,
                    [],
                    props.uiHints,
                  );
                  const blurred = sensitiveCount > 0 && !viewState.rawRevealed;
                  return html`<div class="settings-page">
                    ${rawDiffPanel}
                    <!-- Raw editor: one group surface owning file-level operations. -->
                    <div class="settings-group">
                      <div class="settings-row settings-row--stacked">
                        <div class="config-raw-actions">
                          ${
                            props.onOpenFile && props.openFileAllowed !== false
                              ? html`<button class="btn btn--sm" @click=${props.onOpenFile}>
                                  ${icons.fileText} ${t("configView.open")}
                                </button>`
                              : nothing
                          }
                          <button
                            class="btn btn--sm"
                            ?disabled=${configBusy || !hasRawChanges}
                            @click=${props.onRawDiscard}
                          >
                            ${t("configView.rawDiscard")}
                          </button>
                          <button
                            class="btn btn--sm primary"
                            ?disabled=${!canRawSave}
                            aria-busy=${props.saving ? "true" : "false"}
                            @click=${props.onSave}
                          >
                            ${
                              props.saving
                                ? html`<span class="config-action-spinner" aria-hidden="true"
                                      >${icons.loader}</span
                                    >${t("common.saving")}`
                                : t("common.save")
                            }
                          </button>
                        </div>
                        <div class="field config-raw-field">
                          <span style="display:flex;align-items:center;gap:8px;">
                            ${t("configView.rawConfig")}
                            ${
                              sensitiveCount > 0
                                ? html`<span class="settings-count"
                                      >${t(
                                        sensitiveCount === 1
                                          ? "configView.secretCount"
                                          : "configView.secretCountPlural",
                                        { count: String(sensitiveCount) },
                                      )}
                                      ${
                                        blurred ? t("configView.redacted") : t("configView.visible")
                                      }</span
                                    >
                                    <openclaw-tooltip
                                      .content=${
                                        blurred
                                          ? t("configView.revealSensitive")
                                          : t("configView.hideSensitive")
                                      }
                                    >
                                      <button
                                        class="btn btn--icon config-raw-toggle ${
                                          blurred ? "" : "active"
                                        }"
                                        aria-label=${t("configView.toggleRawRedaction")}
                                        aria-pressed=${!blurred}
                                        @click=${() => {
                                          viewState.rawRevealed = !viewState.rawRevealed;
                                          requestUpdate();
                                        }}
                                      >
                                        ${blurred ? icons.eyeOff : icons.eye}
                                      </button>
                                    </openclaw-tooltip>`
                                : nothing
                            }
                          </span>
                          ${
                            blurred
                              ? html`<div class="callout info" style="margin-top: 12px">
                                  ${t(
                                    sensitiveCount === 1
                                      ? "configView.sensitiveHidden"
                                      : "configView.sensitiveHiddenPlural",
                                    { count: String(sensitiveCount) },
                                  )}
                                </div>`
                              : html`<textarea
                                  placeholder=${t("configView.rawConfig")}
                                  .value=${props.raw}
                                  ?disabled=${configBusy || !mutationAllowed}
                                  @input=${(event: Event) => {
                                    props.onRawChange((event.target as HTMLTextAreaElement).value);
                                  }}
                                ></textarea>`
                          }
                        </div>
                      </div>
                    </div>
                  </div>`;
                })()
      }
      ${
        props.issues.length > 0
          ? html`<div class="config-content-callout">
              <div class="callout danger">
                <pre class="code-block">
${unsafeHTML(highlightJsonHtml(JSON.stringify(props.issues, null, 2)))}</pre>
              </div>
            </div>`
          : nothing
      }
    </div>
  `;
}
