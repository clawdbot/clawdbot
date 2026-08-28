// Control UI view renders config form.render screen content.
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import "./web-awesome-popover.ts";
import { SECTION_META } from "./config-form.meta.ts";
import { renderNode } from "./config-form.node.ts";
import { matchesConfigSectionSearch, parseConfigSearchQuery } from "./config-form.search.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";
import { splitConfigSchemaByTier } from "./config-form.tiers.ts";
import {
  renderLearnMoreLink,
  renderSettingsEmpty,
  renderSettingsHelpTrigger,
  renderSettingsPage,
} from "./settings-ui.ts";

type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  rawAvailable?: boolean;
  disabled?: boolean;
  unsupportedPaths?: string[];
  searchQuery?: string;
  activeSection?: string | null;
  activeSubsection?: string | null;
  showAdvanced?: boolean;
  forceAdvancedSection?: string | null;
  /** Required: the collapsed advanced disclosure's only action. Optional would
   *  permit an inert control that strands hidden settings. */
  onShowAdvanced: () => void;
  /** Paired expanded-state action. Omit when search or a forced route owns the reveal. */
  onHideAdvanced?: () => void;
  /** Inline actions rendered next to the active section heading (e.g. env peek). */
  sectionActions?: TemplateResult;
  showSectionDocs?: boolean;
  /** A Control UI-owned row rendered before common schema rows in the active section. */
  sectionPrelude?: TemplateResult;
  /** Composite pages render custom rows above the form; an empty schema
   *  section must stay silent there instead of claiming the page is empty. */
  embedded?: boolean;
  revealSensitive?: boolean;
  isSensitivePathRevealed?: (path: Array<string | number>) => boolean;
  onToggleSensitivePath?: (path: Array<string | number>) => void;
  onPatch: (path: Array<string | number>, value: unknown) => void;
  onRemove?: (path: Array<string | number>) => void;
};

/** Common/advanced split body shared by the config page and channel forms so
 *  every schema surface uses the same native disclosure. */
export function renderConfigTierGroups(params: {
  schema: JsonSchema;
  path: Array<string | number>;
  hints: ConfigUiHints;
  revealAdvanced: boolean;
  onShowAdvanced: () => void;
  /** Surfaces with collapsible advanced fields pass this as the inverse action. */
  onHideAdvanced?: () => void;
  renderTier: (node: JsonSchema) => TemplateResult | typeof nothing;
  commonPrelude?: TemplateResult;
}) {
  const split = splitConfigSchemaByTier({
    schema: params.schema,
    path: params.path.map(String),
    hints: params.hints,
  });
  // The wrapper owns tier spacing so embedders without a settings-section
  // parent (the channel forms) do not render the tiers flush against each other.
  return html`
    <div class="config-tier-groups">
      ${split.common || params.commonPrelude
        ? html`<div class="settings-group">
            ${params.commonPrelude ?? nothing}${split.common
              ? params.renderTier(split.common)
              : nothing}
          </div>`
        : nothing}
      ${split.advanced && split.advancedLeafCount > 0
        ? html`<details
            class="config-advanced-disclosure"
            ?open=${params.revealAdvanced}
            @toggle=${(event: Event) => {
              const disclosure = event.currentTarget;
              if (!(disclosure instanceof HTMLDetailsElement)) {
                return;
              }
              if (disclosure.open === params.revealAdvanced) {
                return;
              }
              if (disclosure.open) {
                params.onShowAdvanced();
              } else if (params.onHideAdvanced) {
                params.onHideAdvanced();
              } else {
                disclosure.open = true;
              }
            }}
          >
            <summary class="settings-section__heading config-advanced-disclosure__summary">
              ${t("configForm.advancedSettings")}
            </summary>
            ${params.revealAdvanced
              ? html`<div class="settings-group">${params.renderTier(split.advanced)}</div>`
              : nothing}
          </details>`
        : nothing}
    </div>
  `;
}

function matchesSearch(params: {
  key: string;
  schema: JsonSchema;
  sectionValue: unknown;
  uiHints: ConfigUiHints;
  query: string;
}): boolean {
  const meta = SECTION_META[params.key];
  return matchesConfigSectionSearch({
    key: params.key,
    schema: params.schema,
    value: params.sectionValue,
    hints: params.uiHints,
    query: params.query,
    label: meta?.label,
    description: meta?.description,
  });
}

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html` <div class="muted">${t("configForm.schemaUnavailable")}</div> `;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html` <div class="callout danger">${t("configForm.unsupportedSchema")}</div> `;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
  const properties = schema.properties;
  const searchQuery = props.searchQuery ?? "";
  const searchCriteria = parseConfigSearchQuery(searchQuery);
  const activeSection = props.activeSection;
  const activeSubsection = props.activeSubsection ?? null;

  const entries = Object.entries(properties).toSorted((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 50;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 50;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a[0].localeCompare(b[0]);
  });

  const filteredEntries = entries.filter(([key, node]) => {
    if (activeSection && key !== activeSection) {
      return false;
    }
    if (
      searchQuery &&
      !matchesSearch({
        key,
        schema: node,
        sectionValue: value[key],
        uiHints: props.uiHints,
        query: searchQuery,
      })
    ) {
      return false;
    }
    return true;
  });

  let subsectionContext: { sectionKey: string; subsectionKey: string; schema: JsonSchema } | null =
    null;
  if (activeSection && activeSubsection && filteredEntries.length === 1) {
    const sectionSchema = filteredEntries[0]?.[1];
    if (
      sectionSchema &&
      schemaType(sectionSchema) === "object" &&
      sectionSchema.properties &&
      sectionSchema.properties[activeSubsection]
    ) {
      subsectionContext = {
        sectionKey: activeSection,
        subsectionKey: activeSubsection,
        schema: sectionSchema.properties[activeSubsection],
      };
    }
  }

  if (filteredEntries.length === 0) {
    if (props.embedded && !searchQuery) {
      return nothing;
    }
    return renderSettingsPage(
      renderSettingsEmpty(
        searchQuery
          ? t("configForm.noSettingsMatch", { query: searchQuery })
          : t("configForm.noSettingsInSection"),
      ),
    );
  }

  const renderSection = (params: {
    id: string;
    label: string;
    description: string;
    node: JsonSchema;
    nodeValue: unknown;
    path: Array<string | number>;
  }) => {
    const sectionHint = hintForPath(params.path.slice(0, 1), props.uiHints);
    const docsUrl = props.showSectionDocs === false ? undefined : sectionHint?.docsUrl;
    const docsTriggerId = `settings-section-help-${params.id}`;
    const revealAdvanced =
      props.showAdvanced === true ||
      props.forceAdvancedSection === params.path[0] ||
      Boolean(searchQuery);
    const renderTier = (node: JsonSchema) =>
      renderNode({
        schema: node,
        value: params.nodeValue,
        path: params.path,
        hints: props.uiHints,
        rawAvailable: props.rawAvailable ?? true,
        unsupported,
        disabled: props.disabled ?? false,
        showLabel: false,
        showHeaderMeta: true,
        searchCriteria,
        revealSensitive: props.revealSensitive ?? false,
        isSensitivePathRevealed: props.isSensitivePathRevealed,
        onToggleSensitivePath: props.onToggleSensitivePath,
        onPatch: props.onPatch,
        onRemove: props.onRemove,
      });
    return html`
      <section class="settings-section" id=${params.id}>
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${params.label}</h2>
          ${props.sectionActions || docsUrl
            ? html`<div class="settings-section__actions">
                ${props.sectionActions ?? nothing}
                ${docsUrl
                  ? html`
                      <span class="settings-section__docs">
                        ${renderSettingsHelpTrigger({
                          id: docsTriggerId,
                          label: t("configForm.sectionHelp", { section: params.label }),
                          tooltip: t("configForm.sectionHelp", { section: params.label }),
                          icon: "question",
                          popoverId: `settings-section-help-popover-${params.id}`,
                        })}
                        <wa-popover
                          id=${`settings-section-help-popover-${params.id}`}
                          class="settings-section__help-popover"
                          for=${docsTriggerId}
                          placement="bottom-end"
                        >
                          <div class="settings-section__help-panel">
                            ${params.description ? html`<p>${params.description}</p>` : nothing}
                            ${renderLearnMoreLink(docsUrl)}
                          </div>
                        </wa-popover>
                      </span>
                    `
                  : nothing}
              </div>`
            : nothing}
        </div>
        ${params.description
          ? html`<p class="settings-section__desc">${params.description}</p>`
          : nothing}
        ${renderConfigTierGroups({
          schema: params.node,
          path: params.path,
          hints: props.uiHints,
          revealAdvanced,
          onShowAdvanced: props.onShowAdvanced,
          onHideAdvanced:
            props.showAdvanced === true &&
            props.forceAdvancedSection !== params.path[0] &&
            !searchQuery
              ? props.onHideAdvanced
              : undefined,
          renderTier,
          commonPrelude: props.sectionPrelude,
        })}
      </section>
    `;
  };

  return renderSettingsPage(
    subsectionContext
      ? (() => {
          const { sectionKey, subsectionKey, schema: node } = subsectionContext;
          const hint = hintForPath([sectionKey, subsectionKey], props.uiHints);
          const label = hint?.label ?? node.title ?? humanize(subsectionKey);
          const description = hint?.help ?? node.description ?? "";
          const sectionValue = value[sectionKey];
          const scopedValue =
            sectionValue && typeof sectionValue === "object"
              ? (sectionValue as Record<string, unknown>)[subsectionKey]
              : undefined;
          return renderSection({
            id: `config-section-${sectionKey}-${subsectionKey}`,
            label,
            description,
            node,
            nodeValue: scopedValue,
            path: [sectionKey, subsectionKey],
          });
        })()
      : filteredEntries.map(([key, node]) => {
          const meta = SECTION_META[key] ?? {
            label: key.charAt(0).toUpperCase() + key.slice(1),
            description: node.description ?? "",
          };

          return renderSection({
            id: `config-section-${key}`,
            label: meta.label,
            description: meta.description,
            node,
            nodeValue: value[key],
            path: [key],
          });
        }),
  );
}
