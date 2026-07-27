// Pure view for the Dreaming tab of the Memory settings page: the global
// schedule/storage/phase knobs. The controller (context, config writes, agent
// picker) lives in memory-dreaming-page.ts, mirroring memory.ts/memory-page.ts.
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsToggleRow,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

/** Manifest bounds for a numeric field; `count` is `{integer, minimum}`, `ratio` is `0..1`. */
type DreamingNumberBounds = { integer: boolean; min: number; max?: number };

const COUNT_FROM_ZERO: DreamingNumberBounds = { integer: true, min: 0 };
const COUNT_FROM_ONE: DreamingNumberBounds = { integer: true, min: 1 };
const RATIO: DreamingNumberBounds = { integer: false, min: 0, max: 1 };

type DreamingFieldSpec =
  | {
      kind: "text";
      path: readonly string[];
      labelKey: string;
      helpKey: string;
      placeholderKey?: string;
    }
  | {
      kind: "number";
      path: readonly string[];
      labelKey: string;
      helpKey: string;
      bounds: DreamingNumberBounds;
    }
  | {
      kind: "toggle";
      path: readonly string[];
      labelKey: string;
      helpKey: string;
      /** Runtime value for an absent key; see resolveMemoryDreamingConfig. */
      fallback: boolean;
    };

type DreamingFieldGroup = {
  titleKey: string;
  descriptionKey: string;
  fields: readonly DreamingFieldSpec[];
};

// Mirrors the memory-core manifest configSchema/uiHints
// (extensions/memory-core/openclaw.plugin.json). Everything here previously
// required hand-editing openclaw.json. `bounds` restates that manifest's
// integer/minimum/maximum constraints so a rejected value is caught at the input
// instead of after autosave hands it to the gateway.
//
// Toggle `fallback` and the storage-mode default below restate
// resolveMemoryDreamingConfig in src/memory-host-sdk/dreaming.ts: an absent
// key is not "off", so rendering `false` would report the opposite of what the
// sweep actually does. Keep the two in sync.
const DREAMING_SCHEDULE_FIELDS: readonly DreamingFieldSpec[] = [
  {
    kind: "text",
    path: ["frequency"],
    labelKey: "memoryPage.dreaming.frequency.label",
    helpKey: "memoryPage.dreaming.frequency.help",
    placeholderKey: "memoryPage.dreaming.frequency.placeholder",
  },
  {
    kind: "text",
    path: ["timezone"],
    labelKey: "memoryPage.dreaming.timezone.label",
    helpKey: "memoryPage.dreaming.timezone.help",
    placeholderKey: "memoryPage.dreaming.timezone.placeholder",
  },
  {
    kind: "text",
    path: ["model"],
    labelKey: "memoryPage.dreaming.model.label",
    helpKey: "memoryPage.dreaming.model.help",
    placeholderKey: "memoryPage.dreaming.model.placeholder",
  },
  {
    kind: "toggle",
    path: ["verboseLogging"],
    labelKey: "memoryPage.dreaming.verboseLogging.label",
    helpKey: "memoryPage.dreaming.verboseLogging.help",
    // DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING
    fallback: false,
  },
];

const DREAMING_PHASE_GROUPS: readonly DreamingFieldGroup[] = [
  {
    titleKey: "memoryPage.dreaming.phases.light.title",
    descriptionKey: "memoryPage.dreaming.phases.light.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "light", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
        fallback: true,
      },
      {
        kind: "number",
        path: ["phases", "light", "lookbackDays"],
        labelKey: "memoryPage.dreaming.phaseFields.lookbackDays",
        helpKey: "memoryPage.dreaming.phaseFields.lookbackDaysHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "light", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "light", "dedupeSimilarity"],
        labelKey: "memoryPage.dreaming.phaseFields.dedupeSimilarity",
        helpKey: "memoryPage.dreaming.phaseFields.dedupeSimilarityHelp",
        bounds: RATIO,
      },
    ],
  },
  {
    titleKey: "memoryPage.dreaming.phases.deep.title",
    descriptionKey: "memoryPage.dreaming.phases.deep.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "deep", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
        fallback: true,
      },
      {
        kind: "number",
        path: ["phases", "deep", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "deep", "minScore"],
        labelKey: "memoryPage.dreaming.phaseFields.minScore",
        helpKey: "memoryPage.dreaming.phaseFields.minScoreHelp",
        bounds: RATIO,
      },
      {
        kind: "number",
        path: ["phases", "deep", "minRecallCount"],
        labelKey: "memoryPage.dreaming.phaseFields.minRecallCount",
        helpKey: "memoryPage.dreaming.phaseFields.minRecallCountHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "deep", "minUniqueQueries"],
        labelKey: "memoryPage.dreaming.phaseFields.minUniqueQueries",
        helpKey: "memoryPage.dreaming.phaseFields.minUniqueQueriesHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "deep", "recencyHalfLifeDays"],
        labelKey: "memoryPage.dreaming.phaseFields.recencyHalfLifeDays",
        helpKey: "memoryPage.dreaming.phaseFields.recencyHalfLifeDaysHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "deep", "maxAgeDays"],
        labelKey: "memoryPage.dreaming.phaseFields.maxAgeDays",
        helpKey: "memoryPage.dreaming.phaseFields.maxAgeDaysHelp",
        bounds: COUNT_FROM_ONE,
      },
      {
        kind: "number",
        path: ["phases", "deep", "maxPromotedSnippetTokens"],
        labelKey: "memoryPage.dreaming.phaseFields.maxPromotedSnippetTokens",
        helpKey: "memoryPage.dreaming.phaseFields.maxPromotedSnippetTokensHelp",
        bounds: COUNT_FROM_ONE,
      },
    ],
  },
  {
    titleKey: "memoryPage.dreaming.phases.rem.title",
    descriptionKey: "memoryPage.dreaming.phases.rem.description",
    fields: [
      {
        kind: "toggle",
        path: ["phases", "rem", "enabled"],
        labelKey: "memoryPage.dreaming.phaseFields.enabled",
        helpKey: "memoryPage.dreaming.phaseFields.enabledHelp",
        fallback: true,
      },
      {
        kind: "number",
        path: ["phases", "rem", "lookbackDays"],
        labelKey: "memoryPage.dreaming.phaseFields.lookbackDays",
        helpKey: "memoryPage.dreaming.phaseFields.lookbackDaysHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "rem", "limit"],
        labelKey: "memoryPage.dreaming.phaseFields.limit",
        helpKey: "memoryPage.dreaming.phaseFields.limitHelp",
        bounds: COUNT_FROM_ZERO,
      },
      {
        kind: "number",
        path: ["phases", "rem", "minPatternStrength"],
        labelKey: "memoryPage.dreaming.phaseFields.minPatternStrength",
        helpKey: "memoryPage.dreaming.phaseFields.minPatternStrengthHelp",
        bounds: RATIO,
      },
    ],
  },
];

const STORAGE_MODES = ["inline", "separate", "both"] as const;
type StorageMode = (typeof STORAGE_MODES)[number];

// DEFAULT_MEMORY_DREAMING_STORAGE_MODE in src/memory-host-sdk/dreaming.ts.
const DEFAULT_STORAGE_MODE: StorageMode = "separate";

type DreamingSettingsProps = {
  /** `plugins.entries.<slot owner>.config.dreaming`, or null when unset. */
  dreaming: Record<string, unknown> | null;
  onPatch: (path: readonly string[], value: unknown) => void;
};

function readAtPath(root: Record<string, unknown> | null, path: readonly string[]): unknown {
  let current: Record<string, unknown> | null = root;
  for (const [index, key] of path.entries()) {
    if (!current) {
      return undefined;
    }
    const next = current[key];
    if (index === path.length - 1) {
      return next;
    }
    current = asConfigRecord(next);
  }
  return undefined;
}

function normalizeStorageMode(value: unknown): StorageMode {
  return STORAGE_MODES.find((mode) => mode === value) ?? DEFAULT_STORAGE_MODE;
}

/** Parses an edited number against its manifest bounds; null means "do not write". */
function parseDreamingNumber(raw: string, bounds: DreamingNumberBounds): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < bounds.min) {
    return null;
  }
  if (bounds.integer && !Number.isInteger(parsed)) {
    return null;
  }
  return bounds.max !== undefined && parsed > bounds.max ? null : parsed;
}

function renderField(props: DreamingSettingsProps, spec: DreamingFieldSpec) {
  const value = readAtPath(props.dreaming, spec.path);
  if (spec.kind === "toggle") {
    return renderSettingsToggleRow({
      title: t(spec.labelKey),
      description: t(spec.helpKey),
      checked: typeof value === "boolean" ? value : spec.fallback,
      onChange: (checked) => props.onPatch(spec.path, checked),
    });
  }
  const text =
    spec.kind === "number"
      ? typeof value === "number"
        ? String(value)
        : ""
      : typeof value === "string"
        ? value
        : "";
  const bounds = spec.kind === "number" ? spec.bounds : null;
  return renderSettingsRow({
    title: t(spec.labelKey),
    description: t(spec.helpKey),
    control: html`
      <input
        class="settings-input"
        type=${spec.kind === "number" ? "number" : "text"}
        min=${bounds ? String(bounds.min) : nothing}
        max=${bounds?.max !== undefined ? String(bounds.max) : nothing}
        step=${bounds ? (bounds.integer ? "1" : "any") : nothing}
        spellcheck="false"
        aria-label=${t(spec.labelKey)}
        .value=${text}
        placeholder=${spec.kind === "text" && spec.placeholderKey ? t(spec.placeholderKey) : ""}
        @change=${(event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          const next = input.value.trim();
          if (!next) {
            props.onPatch(spec.path, undefined);
            return;
          }
          if (bounds) {
            const parsed = parseDreamingNumber(next, bounds);
            if (parsed === null) {
              // Autosave would write this straight into a config the gateway
              // rejects, leaving a failed save and no field to correct.
              input.value = text;
              return;
            }
            props.onPatch(spec.path, parsed);
            return;
          }
          props.onPatch(spec.path, next);
        }}
      />
    `,
  });
}

/** The global dreaming knobs, editable only when the slot owner stores them. */
export function renderDreamingSettings(props: DreamingSettingsProps): TemplateResult {
  const storageMode = normalizeStorageMode(readAtPath(props.dreaming, ["storage", "mode"]));
  return html`
    ${renderSettingsSection(
      {
        title: t("memoryPage.dreaming.schedule.title"),
        description: t("memoryPage.dreaming.schedule.description"),
      },
      DREAMING_SCHEDULE_FIELDS.map((spec) => renderField(props, spec)),
    )}
    ${renderSettingsSection(
      {
        title: t("memoryPage.dreaming.storage.title"),
        description: t("memoryPage.dreaming.storage.description"),
      },
      html`
        ${renderSettingsRow({
          title: t("memoryPage.dreaming.storage.modeLabel"),
          description: t("memoryPage.dreaming.storage.modeHelp"),
          stacked: true,
          control: renderSettingsSegmented<StorageMode>({
            value: storageMode,
            options: STORAGE_MODES.map((mode) => ({
              value: mode,
              label: t(`memoryPage.dreaming.storage.modes.${mode}`),
            })),
            ariaLabel: t("memoryPage.dreaming.storage.modeLabel"),
            onChange: (mode) => props.onPatch(["storage", "mode"], mode),
          }),
        })}
        ${renderField(props, {
          kind: "toggle",
          path: ["storage", "separateReports"],
          labelKey: "memoryPage.dreaming.storage.separateReportsLabel",
          helpKey: "memoryPage.dreaming.storage.separateReportsHelp",
          // DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS
          fallback: false,
        })}
      `,
    )}
    ${DREAMING_PHASE_GROUPS.map((group) =>
      renderSettingsSection(
        { title: t(group.titleKey), description: t(group.descriptionKey) },
        group.fields.map((spec) => renderField(props, spec)),
      ),
    )}
  `;
}

/**
 * Shown instead of the knobs when the slot-owning plugin's config schema has no
 * `dreaming` child: writing these fields would be rejected by the gateway, so
 * the page must not pretend they are editable.
 */
export function renderDreamingUnsupported(pluginId: string): TemplateResult {
  return renderSettingsSection(
    { title: t("memoryPage.dreaming.unsupported.title") },
    renderSettingsRow({
      title: t("memoryPage.dreaming.unsupported.rowTitle"),
      description: t("memoryPage.dreaming.unsupported.description", { plugin: pluginId }),
    }),
  );
}
