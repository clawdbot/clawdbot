// Curated Talk home: realtime provider/model/voice pickers driven by
// talk.catalog, above the embedded talk schema editor (see memory.ts for the
// same curated-rows-above-schema shape). The pickers and the raw form patch the
// same config draft, so both stay in sync without narrowing the schema.
import { html, nothing, type TemplateResult } from "lit";
import type { NativeDeviceSettingsCapability } from "../../app/native-device-settings.ts";
import { renderModelPicker } from "../../components/model-picker.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import {
  renderDeviceTalk,
  renderVoiceWakeEditor,
  type VoiceWakeEditorState,
} from "./talk-device.ts";
import { isTalkGptLiveModel, type TalkRealtimeSelection } from "./talk-schema.ts";

/** One realtime provider row from talk.catalog, reduced to what the pickers use. */
export type TalkRealtimeProviderOption = {
  id: string;
  label: string;
  configured: boolean;
  aliases: readonly string[];
  models: readonly string[];
  voices: readonly string[];
  voicesByModel?: Record<string, readonly string[]>;
  /** Empty when the catalog does not declare transports for the provider. */
  transports: readonly string[];
  defaultModel: string | null;
};

/**
 * Catalog as the page knows it. `loading`/`unavailable` keep an unread catalog
 * from rendering as a decided "not configured"; only `ready` makes claims.
 */
export type TalkCatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      ready: boolean;
      activeProvider: string | null;
      providers: readonly TalkRealtimeProviderOption[];
    };

type TalkViewProps = {
  nativeDeviceSettings?: NativeDeviceSettingsCapability | null;
  voiceWake?: { state: VoiceWakeEditorState; onInput: (text: string) => void; onRetry: () => void };
  selection: TalkRealtimeSelection;
  catalog: TalkCatalogState;
  configBusy: boolean;
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (model: string | null) => void;
  onVoiceChange: (voice: string | null) => void;
  /** Embedded schema editor for the full `talk` section. */
  editor: TemplateResult;
};

const TALK_PICKER_UNSET = "";

/** Config may name a provider by alias; pickers always speak canonical ids. */
function findProviderOption(
  providers: readonly TalkRealtimeProviderOption[],
  providerId: string | null,
): TalkRealtimeProviderOption | undefined {
  if (!providerId) {
    return undefined;
  }
  return providers.find(
    (provider) => provider.id === providerId || provider.aliases.includes(providerId),
  );
}

/**
 * The provider whose models/voices the pickers offer: the explicitly
 * configured one, else the catalog's credential-based auto-selection. An
 * explicit provider the catalog cannot resolve returns no option — falling
 * back to the active provider would offer another provider's models and let a
 * "Provider default" reset clear that unrelated provider's entry.
 */
export function selectedTalkProviderOption(
  catalog: TalkCatalogState,
  selection: TalkRealtimeSelection,
): TalkRealtimeProviderOption | undefined {
  if (catalog.kind !== "ready") {
    return undefined;
  }
  if (selection.provider) {
    return findProviderOption(catalog.providers, selection.provider);
  }
  return findProviderOption(catalog.providers, catalog.activeProvider);
}

/**
 * Raw config keys under talk.realtime.providers that belong to the selected
 * provider: the configured spelling plus the canonical id and its aliases.
 * Used both to read effective fallback values and to clear them on reset.
 */
export function talkProviderConfigKeys(
  selection: TalkRealtimeSelection,
  option: TalkRealtimeProviderOption | undefined,
): string[] {
  const candidates = [selection.provider, option?.id, ...(option?.aliases ?? [])];
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (candidate && candidate in selection.providerEntries && !keys.includes(candidate)) {
      keys.push(candidate);
    }
  }
  return keys;
}

/** Effective model/voice: top-level override, else the provider entry value. */
export function effectiveTalkValues(
  selection: TalkRealtimeSelection,
  option: TalkRealtimeProviderOption | undefined,
): { model: string | null; speakerVoice: string | null } {
  let model = selection.model;
  let speakerVoice = selection.speakerVoice;
  for (const key of talkProviderConfigKeys(selection, option)) {
    const entry = selection.providerEntries[key];
    model ??= entry?.model ?? null;
    speakerVoice ??= entry?.speakerVoice ?? null;
  }
  return { model, speakerVoice };
}

function renderStatusRow(props: TalkViewProps) {
  const catalog = props.catalog;
  if (catalog.kind === "loading") {
    return renderSettingsRow({
      title: t("talkPage.status.title"),
      control: renderSettingsStatus({ kind: "muted", label: t("common.loading") }),
    });
  }
  if (catalog.kind === "unavailable") {
    return renderSettingsRow({
      title: t("talkPage.status.title"),
      description: t("talkPage.status.unavailableHint"),
      control: renderSettingsStatus({ kind: "muted", label: t("talkPage.status.unavailable") }),
    });
  }
  return renderSettingsRow({
    title: t("talkPage.status.title"),
    description: catalog.activeProvider
      ? t("talkPage.status.activeProvider", { provider: catalog.activeProvider })
      : t("talkPage.status.noProvider"),
    control: catalog.ready
      ? renderSettingsStatus({ kind: "ok", label: t("talkPage.status.ready") })
      : renderSettingsStatus({ kind: "warn", label: t("talkPage.status.notReady") }),
  });
}

function renderProviderRow(props: TalkViewProps) {
  if (props.catalog.kind !== "ready" || props.catalog.providers.length === 0) {
    return renderSettingsRow({
      title: t("talkPage.provider.title"),
      description: t("talkPage.provider.description"),
      control: renderSettingsValue(props.selection.provider ?? t("talkPage.provider.auto"), {
        mono: true,
      }),
    });
  }
  const selected = findProviderOption(props.catalog.providers, props.selection.provider);
  // A configured provider missing from the catalog (for example a disabled
  // plugin) must stay visible as itself, not silently render as Auto.
  const unknownConfigured = props.selection.provider && !selected ? props.selection.provider : null;
  return renderSettingsRow({
    title: t("talkPage.provider.title"),
    description: t("talkPage.provider.description"),
    stacked: true,
    control: renderSettingsSegmented({
      value: selected?.id ?? unknownConfigured ?? TALK_PICKER_UNSET,
      options: [
        ...props.catalog.providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
        })),
        ...(unknownConfigured ? [{ value: unknownConfigured, label: unknownConfigured }] : []),
        { value: TALK_PICKER_UNSET, label: t("talkPage.provider.auto") },
      ],
      disabled: props.configBusy,
      ariaLabel: t("talkPage.provider.title"),
      onChange: (value) => props.onProviderChange(value || null),
    }),
  });
}

function renderModelRow(props: TalkViewProps) {
  const provider = selectedTalkProviderOption(props.catalog, props.selection);
  const { model } = effectiveTalkValues(props.selection, provider);
  if (!provider) {
    return renderSettingsRow({
      title: t("talkPage.model.title"),
      description: t("talkPage.model.description"),
      control: renderSettingsValue(model ?? t("talkPage.model.default"), { mono: true }),
    });
  }
  const known = provider.models.length
    ? provider.models
    : provider.defaultModel
      ? [provider.defaultModel]
      : [];
  const options = [
    {
      value: TALK_PICKER_UNSET,
      label: provider.defaultModel
        ? t("talkPage.model.defaultNamed", { model: provider.defaultModel })
        : t("talkPage.model.default"),
    },
    ...known.map((value) => ({ value, label: value })),
    // A hand-edited model stays selectable instead of snapping to default.
    ...(model && !known.includes(model) ? [{ value: model, label: model }] : []),
  ];
  return renderSettingsRow({
    title: t("talkPage.model.title"),
    description: t("talkPage.model.description"),
    control: renderModelPicker({
      label: t("talkPage.model.title"),
      value: model ?? TALK_PICKER_UNSET,
      options: options.map(({ value, label }) => ({ value, label, provider: provider.id })),
      disabled: props.configBusy,
      onChange: (value) => props.onModelChange(value || null),
    }),
  });
}

function renderVoiceRow(props: TalkViewProps) {
  const provider = selectedTalkProviderOption(props.catalog, props.selection);
  const { model, speakerVoice: voice } = effectiveTalkValues(props.selection, provider);
  const voices =
    provider?.voicesByModel?.[model ?? provider.defaultModel ?? ""] ?? provider?.voices ?? [];
  if (voices.length === 0) {
    return renderSettingsRow({
      title: t("talkPage.voice.title"),
      description: t("talkPage.voice.description"),
      control: renderSettingsValue(voice ?? t("talkPage.voice.default"), { mono: true }),
    });
  }
  const options = [
    { value: TALK_PICKER_UNSET, label: t("talkPage.voice.default") },
    ...voices.map((value) => ({ value, label: value })),
    ...(voice && !voices.includes(voice) ? [{ value: voice, label: voice }] : []),
  ];
  return renderSettingsSelectRow({
    title: t("talkPage.voice.title"),
    description: t("talkPage.voice.description"),
    value: voice ?? TALK_PICKER_UNSET,
    options,
    disabled: props.configBusy,
    onChange: (value) => props.onVoiceChange(value || null),
  });
}

/**
 * GPT-Live is the one model family whose auth differs from the rest of the
 * provider (ChatGPT OAuth works, no Platform key needed), so it gets its own
 * explainer row instead of a footnote in the provider description.
 */
function renderGptLiveRow(props: TalkViewProps) {
  const provider = selectedTalkProviderOption(props.catalog, props.selection);
  const { model } = effectiveTalkValues(props.selection, provider);
  if (provider?.id !== "openai" || !isTalkGptLiveModel(model)) {
    return nothing;
  }
  // `configured` is a generic readiness boolean: false can also mean a broken
  // configured API key or an unavailable broker, so the badge stays neutral and
  // the description carries the sign-in guidance.
  return renderSettingsRow({
    title: t("talkPage.gptLive.title"),
    description: t("talkPage.gptLive.hint"),
    control: provider.configured
      ? renderSettingsStatus({ kind: "ok", label: t("talkPage.gptLive.ready") })
      : renderSettingsStatus({ kind: "warn", label: t("talkPage.status.notReady") }),
  });
}

export function renderTalk(props: TalkViewProps) {
  return html`
    <section class="talk-page">
      <div class="settings-page">
        ${renderDeviceTalk(props.nativeDeviceSettings)}
        ${props.voiceWake ? renderVoiceWakeEditor(props.voiceWake.state, props.voiceWake.onInput, props.voiceWake.onRetry) : nothing}
        ${renderSettingsSection(
          {
            title: t("talkPage.voiceSection.title"),
            description: t("talkPage.voiceSection.description"),
          },
          html`
            ${renderStatusRow(props)} ${renderProviderRow(props)} ${renderModelRow(props)}
            ${renderVoiceRow(props)} ${renderGptLiveRow(props)}
          `,
        )}
      </div>
      ${props.editor}
    </section>
  `;
}
