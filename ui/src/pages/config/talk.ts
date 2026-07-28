// Curated Talk home: realtime provider/model/voice pickers driven by
// talk.catalog, above the embedded talk schema editor (see memory.ts for the
// same curated-rows-above-schema shape). The pickers and the raw form patch the
// same config draft, so both stay in sync without narrowing the schema.
import { html, nothing, type TemplateResult } from "lit";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { isTalkGptLiveModel, type TalkRealtimeSelection } from "./talk-schema.ts";

/** One realtime provider row from talk.catalog, reduced to what the pickers use. */
export type TalkRealtimeProviderOption = {
  id: string;
  label: string;
  configured: boolean;
  aliases: readonly string[];
  models: readonly string[];
  voices: readonly string[];
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

/** The provider whose models/voices the pickers should offer. */
function selectedProviderOption(props: TalkViewProps): TalkRealtimeProviderOption | undefined {
  if (props.catalog.kind !== "ready") {
    return undefined;
  }
  return (
    findProviderOption(props.catalog.providers, props.selection.provider) ??
    findProviderOption(props.catalog.providers, props.catalog.activeProvider)
  );
}

function renderTalkSelectRow(params: {
  title: string;
  description?: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return renderSettingsRow({
    title: params.title,
    description: params.description,
    control: html`
      <select
        class="settings-select"
        aria-label=${params.title}
        ?disabled=${params.disabled}
        .value=${params.value}
        @change=${(event: Event) =>
          params.onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        ${params.options.map(
          (option) => html`
            <option value=${option.value} ?selected=${params.value === option.value}>
              ${option.label}
            </option>
          `,
        )}
      </select>
    `,
  });
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
      : renderSettingsStatus({ kind: "warning", label: t("talkPage.status.notReady") }),
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
  return renderSettingsRow({
    title: t("talkPage.provider.title"),
    description: t("talkPage.provider.description"),
    stacked: true,
    control: renderSettingsSegmented({
      value: selected?.id ?? TALK_PICKER_UNSET,
      options: [
        ...props.catalog.providers.map((provider) => ({
          value: provider.id,
          label: provider.label,
        })),
        { value: TALK_PICKER_UNSET, label: t("talkPage.provider.auto") },
      ],
      disabled: props.configBusy,
      ariaLabel: t("talkPage.provider.title"),
      onChange: (value) => props.onProviderChange(value || null),
    }),
  });
}

function renderModelRow(props: TalkViewProps) {
  const provider = selectedProviderOption(props);
  const model = props.selection.model;
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
  return renderTalkSelectRow({
    title: t("talkPage.model.title"),
    description: t("talkPage.model.description"),
    value: model ?? TALK_PICKER_UNSET,
    options,
    disabled: props.configBusy,
    onChange: (value) => props.onModelChange(value || null),
  });
}

function renderVoiceRow(props: TalkViewProps) {
  const provider = selectedProviderOption(props);
  const voice = props.selection.speakerVoice;
  if (!provider || provider.voices.length === 0) {
    return renderSettingsRow({
      title: t("talkPage.voice.title"),
      description: t("talkPage.voice.description"),
      control: renderSettingsValue(voice ?? t("talkPage.voice.default"), { mono: true }),
    });
  }
  const options = [
    { value: TALK_PICKER_UNSET, label: t("talkPage.voice.default") },
    ...provider.voices.map((value) => ({ value, label: value })),
    ...(voice && !provider.voices.includes(voice) ? [{ value: voice, label: voice }] : []),
  ];
  return renderTalkSelectRow({
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
  const provider = selectedProviderOption(props);
  if (provider?.id !== "openai" || !isTalkGptLiveModel(props.selection.model)) {
    return nothing;
  }
  return renderSettingsRow({
    title: t("talkPage.gptLive.title"),
    description: t("talkPage.gptLive.hint"),
    control: provider.configured
      ? renderSettingsStatus({ kind: "ok", label: t("talkPage.gptLive.ready") })
      : renderSettingsStatus({ kind: "warning", label: t("talkPage.gptLive.needsAuth") }),
  });
}

export function renderTalk(props: TalkViewProps) {
  return html`
    <section class="talk-page">
      <div class="settings-page">
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
