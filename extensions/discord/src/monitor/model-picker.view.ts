import type { APISelectMenuOption } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
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
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW,
  getDiscordModelPickerModelPage,
  getDiscordModelPickerProviderPage,
  normalizeModelPickerPage,
  type DiscordModelPickerCommandContext,
  type DiscordModelPickerLayout,
  type DiscordModelPickerModelPage,
  type DiscordModelPickerPage,
  type DiscordModelPickerProviderItem,
} from "./model-picker.state.js";

const DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS = 18;

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
  currentModel?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  currentRuntime?: string;
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

function formatProviderButtonLabel(provider: string): string {
  if (provider.length <= DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS) {
    return provider;
  }
  return `${provider.slice(0, DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS - 1)}…`;
}

function chunkProvidersForRows(
  items: DiscordModelPickerProviderItem[],
): DiscordModelPickerProviderItem[][] {
  if (items.length === 0) {
    return [];
  }

  const rowCount = Math.max(1, Math.ceil(items.length / DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW));
  const minPerRow = Math.floor(items.length / rowCount);
  const rowsWithExtraItem = items.length % rowCount;

  const counts = Array.from({ length: rowCount }, (_, index) =>
    index < rowCount - rowsWithExtraItem ? minPerRow : minPerRow + 1,
  );

  const rows: DiscordModelPickerProviderItem[][] = [];
  let cursor = 0;
  for (const count of counts) {
    rows.push(items.slice(cursor, cursor + count));
    cursor += count;
  }
  return rows;
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

function getRuntimeChoices(params: {
  data: ModelsProviderData;
  provider: string;
}): Array<{ id: string; label: string; description?: string }> {
  return (
    params.data.runtimeChoicesByProvider?.get(normalizeProviderId(params.provider)) ?? [
      {
        id: "pi",
        label: "OpenClaw Pi Default",
        description: "Use the built-in OpenClaw Pi runtime.",
      },
    ]
  );
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
  return current && allowed.has(current) ? current : "pi";
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

function buildProviderRows(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  page: DiscordModelPickerPage<DiscordModelPickerProviderItem>;
  currentProvider?: string;
}): Row<Button>[] {
  const rows = chunkProvidersForRows(params.page.items).map(
    (providers) =>
      new Row(
        providers.map((provider) => {
          const style =
            provider.id === params.currentProvider ? ButtonStyle.Primary : ButtonStyle.Secondary;
          return createModelPickerButton({
            label: formatProviderButtonLabel(provider.id),
            style,
            customId: buildDiscordModelPickerCustomId({
              command: params.command,
              action: "provider",
              view: "models",
              provider: provider.id,
              page: params.page.page,
              userId: params.userId,
            }),
          });
        }),
      ),
  );

  return rows;
}

function buildModelRows(params: {
  command: DiscordModelPickerCommandContext;
  userId: string;
  data: ModelsProviderData;
  providerPage: number;
  modelPage: DiscordModelPickerModelPage;
  currentModel?: string;
  pendingModel?: string;
  pendingModelIndex?: number;
  currentRuntime?: string;
  pendingRuntime?: string;
  quickModels?: string[];
}): { rows: DiscordModelPickerRow[]; buttonRow: Row<Button> } {
  const parsedCurrentModel = parseCurrentModelRef(params.currentModel);
  const parsedPendingModel = parseCurrentModelRef(params.pendingModel);
  const rows: DiscordModelPickerRow[] = [];

  const hasQuickModels = (params.quickModels ?? []).length > 0;

  const providerPage = getDiscordModelPickerProviderPage({
    data: params.data,
    page: params.providerPage,
  });
  const providerOptions: APISelectMenuOption[] = providerPage.items.map((provider) => ({
    label: provider.id,
    value: provider.id,
    default: provider.id === params.modelPage.provider,
  }));

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
          userId: params.userId,
        }),
        options: providerOptions,
        placeholder: "Select provider",
      }),
    ]),
  );

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
  const normalizedCurrentRuntime = params.currentRuntime?.trim();
  const shouldCarryRuntime =
    runtimeChoices.length > 1 ||
    (Boolean(normalizedCurrentRuntime) &&
      normalizedCurrentRuntime !== "auto" &&
      normalizedCurrentRuntime !== "pi" &&
      normalizedCurrentRuntime !== "default");
  const stateRuntime = shouldCarryRuntime ? selectedRuntime : undefined;
  if (runtimeChoices.length > 1) {
    rows.push(
      new Row([
        createModelSelect({
          customId: buildDiscordModelPickerCustomId({
            command: params.command,
            action: "runtime",
            view: "models",
            provider: params.modelPage.provider,
            runtime: selectedRuntime,
            page: params.modelPage.page,
            providerPage: providerPage.page,
            modelIndex: params.pendingModelIndex,
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

  rows.push(
    new Row([
      createModelSelect({
        customId: buildDiscordModelPickerCustomId({
          command: params.command,
          action: "model",
          view: "models",
          provider: params.modelPage.provider,
          runtime: stateRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
          userId: params.userId,
        }),
        options: modelOptions,
        placeholder: `Select ${params.modelPage.provider} model`,
      }),
    ]),
  );

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
      label: "Cancel",
      style: ButtonStyle.Secondary,
      customId: buildDiscordModelPickerCustomId({
        command: params.command,
        action: "cancel",
        view: "models",
        provider: params.modelPage.provider,
        runtime: stateRuntime,
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
        runtime: stateRuntime,
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
          runtime: stateRuntime,
          page: params.modelPage.page,
          providerPage: providerPage.page,
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
        runtime: stateRuntime,
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
  const page = getDiscordModelPickerProviderPage({ data: params.data, page: params.page });
  const parsedCurrent = parseCurrentModelRef(params.currentModel);
  const rows = buildProviderRows({
    command: params.command,
    userId: params.userId,
    page,
    currentProvider: parsedCurrent?.provider,
  });

  const detailLines = [
    formatCurrentModelLine(params.currentModel),
    `Select a provider (${page.totalItems} available).`,
  ];
  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines,
    rows,
    footer: `All ${page.totalItems} providers shown`,
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

  const { rows, buttonRow } = buildModelRows({
    command: params.command,
    userId: params.userId,
    data: params.data,
    providerPage,
    modelPage,
    currentModel: params.currentModel,
    pendingModel: params.pendingModel,
    pendingModelIndex: params.pendingModelIndex,
    currentRuntime: params.currentRuntime,
    pendingRuntime: params.pendingRuntime,
    quickModels: params.quickModels,
  });

  const defaultModel = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  const pendingLine = params.pendingModel
    ? `Selected: ${params.pendingModel} · runtime ${resolveSelectedRuntime({
        data: params.data,
        provider: modelPage.provider,
        currentRuntime: params.currentRuntime,
        pendingRuntime: params.pendingRuntime,
      })} (press Submit)`
    : "Select a model, then press Submit.";

  return buildRenderedShell({
    layout: params.layout ?? "v2",
    title: "Model Picker",
    detailLines: [formatCurrentModelLine(params.currentModel), `Default: ${defaultModel}`],
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
  provider?: string;
  page?: number;
  providerPage?: number;
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
        page: params.page,
        providerPage: params.providerPage,
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
