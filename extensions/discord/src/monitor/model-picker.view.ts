import type { APISelectMenuOption } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import type {
  ModelsProviderData,
  ModelsRuntimeChoice,
} from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  Button,
  Container,
  Row,
  Separator,
  StringSelectMenu,
  TextDisplay,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "../internal/discord.js";
import {
  buildDiscordModelPickerCustomId,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  normalizeModelPickerPage,
  type DiscordModelPickerBucket,
  type DiscordModelPickerCommandContext,
  type DiscordModelPickerLayout,
  type DiscordModelPickerModelPage,
  type DiscordModelPickerPage,
  type DiscordModelPickerProviderItem,
} from "./model-picker.state.js";

const DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID = "mdlpk:nav-indicator";

type DiscordModelPickerButtonOptions = {
  label: string;
  customId: string;
  style?: ButtonStyle;
  disabled?: boolean;
};

type DiscordModelPickerCurrentModelRef = {
  provider: string;
  model: string;
};

type DiscordModelPickerRow = Row<Button> | Row<StringSelectMenu>;
type CompactRuntimeState = {
  runtime?: string;
  runtimeIndex?: number;
};

type DiscordModelPickerRenderShellParams = {
  layout: DiscordModelPickerLayout;
  title: string;
  detailLines: string[];
  rows: DiscordModelPickerRow[];
  footer?: string;
  /** Text shown after the divider but before the interactive rows. */
  preRowText?: string;
  /** Extra rows appended after the main rows, preceded by a divider. */
  trailingRows?: DiscordModelPickerRow[];
};

export type DiscordModelPickerRenderedView = {
  layout: DiscordModelPickerLayout;
  content?: string;
  components: TopLevelComponents[];
};

export type DiscordModelPickerProviderViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  page?: number;
  providerBucket?: string;
  currentModel?: string;
  layout?: DiscordModelPickerLayout;
};

export type DiscordModelPickerModelViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  provider: string;
  page?: number;
  providerPage?: number;
  providerBucket?: string;
  modelBucket?: string;
  currentModel?: string;
  currentRuntime?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
  layout?: DiscordModelPickerLayout;
};

function parseCurrentModelRef(raw?: string): DiscordModelPickerCurrentModelRef | null {
  const trimmed = raw?.trim();
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const provider = normalizeProviderId(match[1]);
  // Preserve the model suffix exactly as entered after "/" so select defaults
  // continue to mirror the stored ref for Discord interactions.
  const model = match[2];
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function formatCurrentModelLine(currentModel?: string): string {
  const parsed = parseCurrentModelRef(currentModel);
  if (!parsed) {
    return "Current model: default";
  }
  return `Current model: ${parsed.provider}/${parsed.model}`;
}

function createModelPickerButton(params: DiscordModelPickerButtonOptions): Button {
  class DiscordModelPickerButton extends Button {
    label = params.label;
    customId = params.customId;
    override style = params.style ?? ButtonStyle.Secondary;
    override disabled = params.disabled ?? false;
  }
  return new DiscordModelPickerButton();
}

function createModelSelect(params: {
  customId: string;
  options: APISelectMenuOption[];
  placeholder?: string;
  disabled?: boolean;
}): StringSelectMenu {
  class DiscordModelPickerSelect extends StringSelectMenu {
    customId = params.customId;
    override options = params.options;
    override minValues = 1;
    override maxValues = 1;
    override placeholder = params.placeholder;
    override disabled = params.disabled ?? false;
  }
  return new DiscordModelPickerSelect();
}

/**
 * Build the alpha-bucket select row that appears above the provider/model
 * surface when the list exceeds {@link DISCORD_MODEL_PICKER_BUCKET_THRESHOLD}.
 *
 * Selecting a bucket emits action=bucket. The chosen bucket travels in the
 * select value, while the custom_id carries only the stable context needed to
 * rebuild the picker under Discord's 100-character custom_id limit.
 */
function buildBucketSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  view: "providers" | "models";
  buckets: DiscordModelPickerBucket[];
  currentBucketId: string | undefined;
  provider?: string;
  runtime?: string;
  runtimeIndex?: number;
  providerPage?: number;
  modelIndex?: number;
  providerBucket?: string;
}): Row<StringSelectMenu> | null {
  if (params.buckets.length <= 1) {
    return null;
  }
  const options: APISelectMenuOption[] = params.buckets.map((bucket) => ({
    label: bucket.label,
    value: bucket.id,
    default: bucket.id === params.currentBucketId,
  }));
  // The bucket select uses `action: "bucket"` so the interaction handler
  // can route the chosen value (interaction.values[0]) into providerBucket
  // or modelBucket and re-render. page resets to 1. providerBucket is
  // intentionally omitted from the customId — when view=models the handler
  // derives the provider bucket from `params.provider` via
  // findProviderBucketId, keeping the customId under Discord's 100-char
  // cap for long provider ids + 20-digit user ids.
  const select = createModelSelect({
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "bucket",
      view: params.view,
      userId: params.userId,
      page: 1,
      provider: params.provider,
      runtime: params.runtime,
      runtimeIndex: params.runtimeIndex,
      providerPage: params.providerPage,
      modelIndex: params.modelIndex,
    }),
    options,
    placeholder:
      params.view === "providers"
        ? "Filter providers by letter range"
        : "Filter models by letter range",
  });
  return new Row([select]);
}

function getRuntimeChoices(params: {
  data: ModelsProviderData;
  provider: string;
}): ModelsRuntimeChoice[] {
  const choices = params.data.runtimeChoicesByProvider?.get(normalizeProviderId(params.provider));
  if (choices?.length) {
    return choices;
  }
  return [
    {
      id: "openclaw",
      label: "OpenClaw Default",
      description: "Use the built-in OpenClaw runtime.",
    },
  ];
}

function resolveSelectedRuntime(params: {
  data: ModelsProviderData;
  provider: string;
  currentRuntime?: string;
  pendingRuntime?: string;
}): string {
  const choices = getRuntimeChoices({ data: params.data, provider: params.provider });
  const allowed = new Set(choices.map((choice) => choice.id));
  const pending = params.pendingRuntime?.trim();
  if (pending && allowed.has(pending)) {
    return pending;
  }
  const current = params.currentRuntime?.trim();
  if (current && allowed.has(current)) {
    return current;
  }
  return choices[0]?.id ?? "openclaw";
}

function resolveExplicitRuntimeState(params: {
  choices: ModelsRuntimeChoice[];
  currentRuntime?: string;
  pendingRuntime?: string;
}): string | undefined {
  const allowed = new Set(params.choices.map((choice) => choice.id));
  const pending = params.pendingRuntime?.trim();
  if (pending && allowed.has(pending)) {
    return pending;
  }
  const current = params.currentRuntime?.trim();
  if (current && current !== "auto" && current !== "default" && allowed.has(current)) {
    return current;
  }
  return undefined;
}

function getActiveBucketId(
  bucket: DiscordModelPickerBucket | null | undefined,
): string | undefined {
  return bucket && bucket.id !== "all" ? bucket.id : undefined;
}

function resolveCompactRuntimeState(params: {
  choices: ModelsRuntimeChoice[];
  currentRuntime?: string;
  pendingRuntime?: string;
}): CompactRuntimeState {
  const stateRuntime = resolveExplicitRuntimeState(params);
  const stateRuntimeIndex = stateRuntime
    ? params.choices.findIndex((choice) => choice.id === stateRuntime)
    : -1;
  if (stateRuntimeIndex >= 0) {
    return { runtimeIndex: stateRuntimeIndex + 1 };
  }
  return stateRuntime ? { runtime: stateRuntime } : {};
}

function buildRenderedShell(
  params: DiscordModelPickerRenderShellParams,
): DiscordModelPickerRenderedView {
  if (params.layout === "classic") {
    const lines = [params.title, ...params.detailLines, "", params.footer].filter(Boolean);
    return {
      layout: "classic",
      content: lines.join("\n"),
      components: params.rows,
    };
  }

  const containerComponents: Array<TextDisplay | Separator | DiscordModelPickerRow> = [
    new TextDisplay(`## ${params.title}`),
  ];
  if (params.detailLines.length > 0) {
    containerComponents.push(new TextDisplay(params.detailLines.join("\n")));
  }
  containerComponents.push(new Separator({ divider: true, spacing: "small" }));
  if (params.preRowText) {
    containerComponents.push(new TextDisplay(params.preRowText));
  }
  containerComponents.push(...params.rows);
  if (params.trailingRows && params.trailingRows.length > 0) {
    containerComponents.push(new Separator({ divider: true, spacing: "small" }));
    containerComponents.push(...params.trailingRows);
  }
  if (params.footer) {
    containerComponents.push(new Separator({ divider: false, spacing: "small" }));
    containerComponents.push(new TextDisplay(`-# ${params.footer}`));
  }

  const container = new Container(containerComponents);
  return {
    layout: "v2",
    components: [container],
  };
}

function buildProviderSelectRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  page: DiscordModelPickerPage<DiscordModelPickerProviderItem>;
  currentProvider?: string;
  providerBucket?: string;
}): Row<StringSelectMenu> | null {
  if (params.page.items.length === 0) {
    return null;
  }
  const options: APISelectMenuOption[] = params.page.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === params.currentProvider,
    description: `${provider.count} ${provider.count === 1 ? "model" : "models"}`,
  }));
  return new Row([
    createModelSelect({
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "provider",
        view: "models",
        page: params.page.page,
        providerPage: params.page.page,
        providerBucket: params.providerBucket,
        userId: params.userId,
      }),
      options,
      placeholder: "Select provider",
    }),
  ]);
}

function buildPaginationRow(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  view: "providers" | "models";
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  provider?: string;
  runtime?: string;
  runtimeIndex?: number;
  providerPage?: number;
  modelIndex?: number;
  providerBucket?: string;
  modelBucket?: string;
}): Row<Button> | null {
  if (params.totalPages <= 1) {
    return null;
  }
  const prevButton = createModelPickerButton({
    label: "◀ Prev",
    style: ButtonStyle.Secondary,
    disabled: !params.hasPrev,
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "nav",
      view: params.view,
      provider: params.provider,
      runtime: params.runtime,
      runtimeIndex: params.runtimeIndex,
      page: Math.max(1, params.page - 1),
      providerPage: params.providerPage,
      modelIndex: params.modelIndex,
      providerBucket: params.providerBucket,
      modelBucket: params.modelBucket,
      userId: params.userId,
    }),
  });
  const indicatorButton = createModelPickerButton({
    label: `Page ${params.page}/${params.totalPages}`,
    style: ButtonStyle.Secondary,
    disabled: true,
    customId: DISCORD_MODEL_PICKER_PAGE_INDICATOR_CUSTOM_ID,
  });
  const nextButton = createModelPickerButton({
    label: "Next ▶",
    style: ButtonStyle.Secondary,
    disabled: !params.hasNext,
    customId: buildDiscordModelPickerCustomId({
      command: params.command,
      action: "nav",
      view: params.view,
      provider: params.provider,
      runtime: params.runtime,
      runtimeIndex: params.runtimeIndex,
      page: Math.min(params.totalPages, params.page + 1),
      providerPage: params.providerPage,
      modelIndex: params.modelIndex,
      providerBucket: params.providerBucket,
      modelBucket: params.modelBucket,
      userId: params.userId,
    }),
  });
  return new Row([prevButton, indicatorButton, nextButton]);
}

function buildModelRows(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  providerPage: number;
  modelPage: DiscordModelPickerModelPage & {
    bucket?: DiscordModelPickerBucket | null;
    buckets?: DiscordModelPickerBucket[];
  };
  currentModel?: string;
  currentRuntime?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  pendingRuntime?: string;
  quickModels?: string[];
  providerBucket?: string;
}): { rows: DiscordModelPickerRow[]; buttonRow: Row<Button> } {
  const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
  const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
  const rows: DiscordModelPickerRow[] = [];

  const hasQuickModels = (params.quickModels ?? []).length > 0;

  // Preserve the active provider bucket inside the model view so the
  // "switch provider" select shows the same letter range the user picked
  // when entering the model view. Without this the select always falls
  // back to the first bucket and silently jumps the user out of "H–N".
  const providerPage = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.providerPage,
    bucket: params.providerBucket,
  });
  const providerOptions: APISelectMenuOption[] = providerPage.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === params.modelPage.provider,
  }));
  const activeProviderBucket = getActiveBucketId(providerPage.bucket);
  const activeModelBucket = getActiveBucketId(params.modelPage.bucket);
  // Discord caps messages at 5 action rows. Model bucketing adds its own row,
  // so the in-view provider switcher has to yield to the Providers button.
  const modelBucketingActive = (params.modelPage.buckets?.length ?? 0) > 1;
  if (!modelBucketingActive) {
    rows.push(
      new Row([
        createModelSelect({
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "provider",
            view: "models",
            provider: params.modelPage.provider,
            page: providerPage.page,
            providerPage: providerPage.page,
            providerBucket: activeProviderBucket,
            userId: params.userId,
          }),
          options: providerOptions,
          placeholder: "Select provider",
        }),
      ]),
    );
  }

  const runtimeChoices = getRuntimeChoices({
    data: params.data,
    provider: params.modelPage.provider,
  });
  const selectedRuntime = resolveSelectedRuntime({
    data: params.data,
    provider: params.modelPage.provider,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });
  const compactRuntime = resolveCompactRuntimeState({
    choices: runtimeChoices,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
  });

  if (runtimeChoices.length > 1) {
    // The selected runtime travels in the select interaction value; omitting
    // it here leaves enough customId budget to preserve the browse bucket.
    rows.push(
      new Row([
        createModelSelect({
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "runtime",
            view: "models",
            provider: params.modelPage.provider,
            page: params.modelPage.page,
            providerPage: providerPage.page,
            modelIndex: params.pendingModelIndex,
            ...(params.pendingModelIndex === undefined && activeModelBucket
              ? { modelBucket: activeModelBucket }
              : {}),
            userId: params.userId,
          }),
          options: runtimeChoices.map((choice) => {
            const option: APISelectMenuOption = {
              label: choice.label,
              value: choice.id,
              default: choice.id === selectedRuntime,
            };
            if (choice.description) {
              option.description = choice.description;
            }
            return option;
          }),
          placeholder: "Select runtime",
        }),
      ]),
    );
  }

  const selectedModelRef = parsedPendingModel ?? parsedCurrentModel;
  const modelOptions: APISelectMenuOption[] = params.modelPage.items.map((model) => ({
    label: model,
    value: model,
    default: selectedModelRef
      ? selectedModelRef.provider === params.modelPage.provider && selectedModelRef.model === model
      : false,
  }));

  // Model select customId omits providerBucket and modelBucket: both are
  // pure functions of the durable state (provider + picked model) and
  // including them risks blowing past Discord's 100-char customId cap for
  // long provider ids + 20-digit user ids + active bucket strings. The
  // action=model handler derives both buckets via findProviderBucketId /
  // findModelBucketId at re-render time.
  rows.push(
    new Row([
      createModelSelect({
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "model",
          view: "models",
          provider: params.modelPage.provider,
          ...compactRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          userId: params.userId,
        }),
        options: modelOptions,
        placeholder: `Select ${params.modelPage.provider} model`,
      }),
    ]),
  );

  const modelNavRow = buildPaginationRow({
    command: params.command,
    userId: params.userId,
    view: "models",
    page: params.modelPage.page,
    totalPages: params.modelPage.totalPages,
    hasPrev: params.modelPage.hasPrev,
    hasNext: params.modelPage.hasNext,
    provider: params.modelPage.provider,
    ...compactRuntime,
    providerPage: providerPage.page,
    modelIndex: params.pendingModelIndex,
    // Model navigation derives providerBucket from provider on interaction;
    // carrying it here can exceed Discord's 100-char customId limit.
    modelBucket:
      params.modelPage.bucket && params.modelPage.bucket.id !== "all"
        ? params.modelPage.bucket.id
        : undefined,
  });
  if (modelNavRow) {
    rows.push(modelNavRow);
  }

  const resolvedDefault = params.data.resolvedDefault;
  const shouldDisableReset =
    Boolean(parsedCurrentModel) &&
    parsedCurrentModel?.provider === resolvedDefault.provider &&
    parsedCurrentModel?.model === resolvedDefault.model;

  const hasPendingSelection =
    Boolean(parsedPendingModel) &&
    parsedPendingModel?.provider === params.modelPage.provider &&
    typeof params.pendingModelIndex === "number" &&
    params.pendingModelIndex > 0;

  const buttonRowItems: Button[] = [
    createModelPickerButton({
      label: "Providers",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "providers",
        page: providerPage.page,
        providerBucket: activeProviderBucket,
        userId: params.userId,
      }),
    }),
    createModelPickerButton({
      label: "Cancel",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "cancel",
        view: "models",
        provider: params.modelPage.provider,
        ...compactRuntime,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        userId: params.userId,
      }),
    }),
    createModelPickerButton({
      label: "Reset to default",
      style: ButtonStyle.Secondary,
      disabled: shouldDisableReset,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "reset",
        view: "models",
        provider: params.modelPage.provider,
        ...compactRuntime,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        userId: params.userId,
      }),
    }),
  ];

  if (hasQuickModels) {
    buttonRowItems.push(
      createModelPickerButton({
        label: "Recents",
        style: ButtonStyle.Secondary,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "recents",
          view: "recents",
          provider: params.modelPage.provider,
          ...compactRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          modelBucket: activeModelBucket,
          userId: params.userId,
        }),
      }),
    );
  }

  buttonRowItems.push(
    createModelPickerButton({
      label: "Submit",
      style: ButtonStyle.Primary,
      disabled: !hasPendingSelection,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "submit",
        view: "models",
        provider: params.modelPage.provider,
        ...compactRuntime,
        page: params.modelPage.page,
        providerPage: providerPage.page,
        modelIndex: params.pendingModelIndex,
        userId: params.userId,
      }),
    }),
  );

  return { rows, buttonRow: new Row(buttonRowItems) };
}

export function renderDiscordModelPickerProvidersView(
  params: DiscordModelPickerProviderViewParams,
): DiscordModelPickerRenderedView {
  const page = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.page,
    bucket: params.providerBucket,
  });
  const parsedCurrent = parseCurrentModelRef(params.currentModel);
  const rows: DiscordModelPickerRow[] = [];

  const bucketRow = buildBucketSelectRow({
    command: params.command,
    userId: params.userId,
    view: "providers",
    buckets: page.buckets,
    currentBucketId: page.bucket?.id,
  });
  if (bucketRow) {
    rows.push(bucketRow);
  }

  const activeProviderBucket = page.bucket && page.bucket.id !== "all" ? page.bucket.id : undefined;
  const providerRow = buildProviderSelectRow({
    command: params.command,
    userId: params.userId,
    page,
    currentProvider: parsedCurrent?.provider,
    providerBucket: activeProviderBucket,
  });
  if (providerRow) {
    rows.push(providerRow);
  }

  const navRow = buildPaginationRow({
    command: params.command,
    userId: params.userId,
    view: "providers",
    page: page.page,
    totalPages: page.totalPages,
    hasPrev: page.hasPrev,
    hasNext: page.hasNext,
    providerBucket: activeProviderBucket,
  });
  if (navRow) {
    rows.push(navRow);
  }

  const totalProviders = params.data.providers.length;
  const detailLines = [
    formatCurrentModelLine(params.currentModel),
    page.bucket && page.bucket.id !== "all"
      ? `Select a provider (${page.totalItems} in ${page.bucket.label}, ${totalProviders} total).`
      : `Select a provider (${page.totalItems} available).`,
  ];
  const footer =
    page.totalPages > 1
      ? `Showing page ${page.page}/${page.totalPages} · ${page.totalItems} providers total`
      : `All ${page.totalItems} providers shown`;
  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines,
    rows,
    footer,
  });
}

export function renderDiscordModelPickerModelsView(
  params: DiscordModelPickerModelViewParams,
): DiscordModelPickerRenderedView {
  const providerPage = normalizeModelPickerPage(params.providerPage);
  const modelPage = getDiscordModelPickerModelPage({
    data: params.data,
    provider: params.provider,
    page: params.page,
    bucket: params.modelBucket,
  });

  if (!modelPage) {
    const rows: Row<Button>[] = [
      new Row([
        createModelPickerButton({
          label: "Back",
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "back",
            view: "providers",
            page: providerPage,
            userId: params.userId,
          }),
        }),
      ]),
    ];

    return buildRenderedShell({
      layout: params.layout ?? "v2",
      title: "Model Picker",
      detailLines: [
        formatCurrentModelLine(params.currentModel),
        `Provider not found: ${normalizeProviderId(params.provider)}`,
      ],
      rows,
      footer: "Choose a different provider.",
    });
  }

  const { rows: modelRows, buttonRow } = buildModelRows({
    command: params.command,
    userId: params.userId,
    data: params.data,
    providerPage,
    modelPage,
    currentModel: params.currentModel,
    currentRuntime: params.currentRuntime,
    pendingModel: params.pendingModel,
    pendingModelIndex: params.pendingModelIndex,
    pendingRuntime: params.pendingRuntime,
    quickModels: params.quickModels,
    providerBucket: params.providerBucket,
  });
  const runtimeChoices = getRuntimeChoices({
    data: params.data,
    provider: modelPage.provider,
  });
  const pendingRuntime = params.pendingRuntime?.trim();
  const pendingRuntimeIndex = pendingRuntime
    ? runtimeChoices.findIndex((choice) => choice.id === pendingRuntime)
    : -1;

  const rows: DiscordModelPickerRow[] = [];
  const bucketRow = buildBucketSelectRow({
    command: params.command,
    userId: params.userId,
    view: "models",
    buckets: modelPage.buckets,
    currentBucketId: modelPage.bucket?.id,
    provider: modelPage.provider,
    // Carry pending runtime through bucket changes as a compact choice index;
    // raw provider+runtime pairs can exceed Discord's 100-char custom_id cap.
    runtimeIndex: pendingRuntimeIndex >= 0 ? pendingRuntimeIndex + 1 : undefined,
    providerPage,
    providerBucket: params.providerBucket,
  });
  if (bucketRow) {
    rows.push(bucketRow);
  }
  rows.push(...modelRows);

  const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const pendingLine = params.pendingModel
    ? `Selected: ${params.pendingModel} · runtime ${resolveSelectedRuntime({
        data: params.data,
        provider: modelPage.provider,
        currentRuntime: params.currentRuntime,
        pendingRuntime: params.pendingRuntime,
      })} (press Submit)`
    : "Select a model, then press Submit.";

  const detailLines = [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`];
  if (modelPage.totalPages > 1) {
    detailLines.push(
      `${modelPage.provider}: page ${modelPage.page}/${modelPage.totalPages} · ${modelPage.totalItems} models`,
    );
  }

  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines,
    preRowText: pendingLine,
    rows,
    trailingRows: [buttonRow],
  });
}

export type DiscordModelPickerRecentsViewParams = {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  quickModels: string[];
  currentModel?: string;
  runtime?: string;
  runtimeIndex?: number;
  provider?: string;
  page?: number;
  providerPage?: number;
  modelBucket?: string;
  layout?: DiscordModelPickerLayout;
};

function formatRecentsButtonLabel(modelRef: string, suffix?: string): string {
  const maxLen = 80;
  const label = suffix ? `${modelRef} ${suffix}` : modelRef;
  if (label.length <= maxLen) {
    return label;
  }
  const trimmed = suffix
    ? `${modelRef.slice(0, maxLen - suffix.length - 2)}… ${suffix}`
    : `${modelRef.slice(0, maxLen - 1)}…`;
  return trimmed;
}

export function renderDiscordModelPickerRecentsView(
  params: DiscordModelPickerRecentsViewParams,
): DiscordModelPickerRenderedView {
  const defaultModelRef = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const rows: DiscordModelPickerRow[] = [];

  // Dedupe: filter recents that match the default model.
  const dedupedQuickModels = params.quickModels.filter((modelRef) => modelRef !== defaultModelRef);

  // Default model button — slot 1.
  rows.push(
    new Row([
      createModelPickerButton({
        label: formatRecentsButtonLabel(defaultModelRef, "(default)"),
        style: ButtonStyle.Secondary,
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "submit",
          view: "recents",
          recentSlot: 1,
          provider: params.provider,
          runtime: params.runtime,
          runtimeIndex: params.runtimeIndex,
          page: params.page,
          providerPage: params.providerPage,
          userId: params.userId,
        }),
      }),
    ]),
  );

  // Recent model buttons — slot 2+.
  for (let i = 0; i < dedupedQuickModels.length; i++) {
    const modelRef = dedupedQuickModels[i];
    rows.push(
      new Row([
        createModelPickerButton({
          label: formatRecentsButtonLabel(modelRef),
          style: ButtonStyle.Secondary,
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "submit",
            view: "recents",
            recentSlot: i + 2,
            provider: params.provider,
            runtime: params.runtime,
            runtimeIndex: params.runtimeIndex,
            page: params.page,
            providerPage: params.providerPage,
            userId: params.userId,
          }),
        }),
      ]),
    );
  }

  // Back button after a divider (via trailingRows).
  const backRow: Row<Button> = new Row([
    createModelPickerButton({
      label: "Back",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "back",
        view: "models",
        provider: params.provider,
        runtime: params.runtime,
        runtimeIndex: params.runtimeIndex,
        page: params.page,
        providerPage: params.providerPage,
        modelBucket: params.modelBucket,
        userId: params.userId,
      }),
    }),
  ]);

  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Recents",
    detailLines: [
      "Models you've previously selected appear here.",
      formatCurrentModelLine(params.currentModel),
    ],
    preRowText: "Tap a model to switch.",
    rows,
    trailingRows: [backRow],
  });
}

export function toDiscordModelPickerMessagePayload(
  view: DiscordModelPickerRenderedView,
): MessagePayloadObject {
  if (view.layout === "classic") {
    return {
      content: view.content,
      components: view.components,
    };
  }
  return {
    components: view.components,
  };
}
