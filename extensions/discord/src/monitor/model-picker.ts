import {
  Button,
  Container,
  Row,
  Separator,
  StringSelectMenu,
  TextDisplay,
  type ComponentData,
  type MessagePayloadObject,
  type TopLevelComponents,
} from "@buape/carbon";
import type { APISelectMenuOption } from "discord-api-types/v10";
import { ButtonStyle } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";

export const DISCORD_MODEL_PICKER_CUSTOM_ID_KEY = "mdlpk";
export const DISCORD_CUSTOM_ID_MAX_CHARS = 100;

// Discord component limits.
export const DISCORD_COMPONENT_MAX_ROWS = 5;
export const DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW = 5;
export const DISCORD_COMPONENT_MAX_SELECT_OPTIONS = 25;

// Reserve one row for navigation/utility buttons when rendering providers.
export const DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE =
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * (DISCORD_COMPONENT_MAX_ROWS - 1);
// When providers fit in one page, we can use all button rows and hide nav controls.
export const DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX =
  DISCORD_COMPONENT_MAX_BUTTONS_PER_ROW * DISCORD_COMPONENT_MAX_ROWS;
export const DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE = DISCORD_COMPONENT_MAX_SELECT_OPTIONS;

const DISCORD_PROVIDER_BUTTON_LABEL_MAX_CHARS = 18;

const COMMAND_CONTEXTS = ["model", "models"] as const;
const PICKER_ACTIONS = [
  "open",
  "provider",
  "model",
  "runtime",
  "submit",
  "quick",
  "back",
  "reset",
  "cancel",
  "recents",
] as const;
const PICKER_VIEWS = ["providers", "models", "recents"] as const;

export type DiscordModelPickerCommandContext = (typeof COMMAND_CONTEXTS)[number];
export type DiscordModelPickerAction = (typeof PICKER_ACTIONS)[number];
export type DiscordModelPickerView = (typeof PICKER_VIEWS)[number];

export type DiscordModelPickerState = {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  userId: string;
  provider?: string;
  runtime?: string;
  page: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
};

export type DiscordModelPickerProviderItem = {
  id: string;
  count: number;
};

export type DiscordModelPickerPage<T> = {
  items: T[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
  hasPrev: boolean;
  hasNext: boolean;
};

export type DiscordModelPickerModelPage = DiscordModelPickerPage<string> & {
  provider: string;
};

export type DiscordModelPickerLayout = "v2" | "classic";

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

let modelsProviderRuntimePromise:
  | Promise<typeof import("openclaw/plugin-sdk/models-provider-runtime")>
  | undefined;

async function loadModelsProviderRuntime() {
  modelsProviderRuntimePromise ??= import("openclaw/plugin-sdk/models-provider-runtime");
  return await modelsProviderRuntimePromise;
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isValidCommandContext(value: string): value is DiscordModelPickerCommandContext {
  return (COMMAND_CONTEXTS as readonly string[]).includes(value);
}

function isValidPickerAction(value: string): value is DiscordModelPickerAction {
  return (PICKER_ACTIONS as readonly string[]).includes(value);
}

function isValidPickerView(value: string): value is DiscordModelPickerView {
  return (PICKER_VIEWS as readonly string[]).includes(value);
}

function normalizePage(value: number | undefined): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 1;
  }
  return Math.max(1, Math.floor(numeric));
}

function parseRawPage(value: unknown): number {
  if (typeof value === "number") {
    return normalizePage(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return normalizePage(parsed);
    }
  }
  return 1;
}

function parseRawPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return undefined;
  }
  return Math.floor(parsed);
}

function coerceString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function clampPageSize(rawPageSize: number | undefined, max: number, fallback: number): number {
  if (!Number.isFinite(rawPageSize)) {
    return fallback;
  }
  return Math.min(max, Math.max(1, Math.floor(rawPageSize ?? fallback)));
}

function paginateItems<T>(params: {
  items: T[];
  page: number;
  pageSize: number;
}): DiscordModelPickerPage<T> {
  const totalItems = params.items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / params.pageSize));
  const page = Math.max(1, Math.min(params.page, totalPages));
  const startIndex = (page - 1) * params.pageSize;
  const endIndexExclusive = Math.min(totalItems, startIndex + params.pageSize);

  return {
    items: params.items.slice(startIndex, endIndexExclusive),
    page,
    pageSize: params.pageSize,
    totalPages,
    totalItems,
    hasPrev: page > 1,
    hasNext: page < totalPages,
  };
}

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
    style = params.style ?? ButtonStyle.Secondary;
    disabled = params.disabled ?? false;
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
    options = params.options;
    minValues = 1;
    maxValues = 1;
    placeholder = params.placeholder;
    disabled = params.disabled ?? false;
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

/**
 * Source-of-truth data for Discord picker views. This intentionally reuses the
 * same provider/model resolver used by text and Telegram model commands.
 */
export async function loadDiscordModelPickerData(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<ModelsProviderData> {
  const { buildModelsProviderData } = await loadModelsProviderRuntime();
  return buildModelsProviderData(cfg, agentId);
}

export function buildDiscordModelPickerCustomId(params: {
  command: DiscordModelPickerCommandContext;
  action: DiscordModelPickerAction;
  view: DiscordModelPickerView;
  userId: string;
  provider?: string;
  runtime?: string;
  page?: number;
  providerPage?: number;
  modelIndex?: number;
  recentSlot?: number;
}): string {
  const userId = params.userId.trim();
  if (!userId) {
    throw new Error("Discord model picker custom_id requires userId");
  }

  const page = normalizePage(params.page);
  const providerPage =
    typeof params.providerPage === "number" && Number.isFinite(params.providerPage)
      ? Math.max(1, Math.floor(params.providerPage))
      : undefined;
  const normalizedProvider = params.provider ? normalizeProviderId(params.provider) : undefined;
  const modelIndex =
    typeof params.modelIndex === "number" && Number.isFinite(params.modelIndex)
      ? Math.max(1, Math.floor(params.modelIndex))
      : undefined;
  const recentSlot =
    typeof params.recentSlot === "number" && Number.isFinite(params.recentSlot)
      ? Math.max(1, Math.floor(params.recentSlot))
      : undefined;

  const parts = [
    `${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:c=${encodeCustomIdValue(params.command)}`,
    `a=${encodeCustomIdValue(params.action)}`,
    `v=${encodeCustomIdValue(params.view)}`,
    `u=${encodeCustomIdValue(userId)}`,
    `g=${String(page)}`,
  ];
  if (normalizedProvider) {
    parts.push(`p=${encodeCustomIdValue(normalizedProvider)}`);
  }
  const runtime = params.runtime?.trim();
  if (runtime) {
    parts.push(`r=${encodeCustomIdValue(runtime)}`);
  }
  if (providerPage) {
    parts.push(`pp=${String(providerPage)}`);
  }
  if (modelIndex) {
    parts.push(`mi=${String(modelIndex)}`);
  }
  if (recentSlot) {
    parts.push(`rs=${String(recentSlot)}`);
  }

  const customId = parts.join(";");
  if (customId.length > DISCORD_CUSTOM_ID_MAX_CHARS) {
    throw new Error(
      `Discord model picker custom_id exceeds ${DISCORD_CUSTOM_ID_MAX_CHARS} chars (${customId.length})`,
    );
  }
  return customId;
}

export function parseDiscordModelPickerCustomId(customId: string): DiscordModelPickerState | null {
  const trimmed = customId.trim();
  if (!trimmed.startsWith(`${DISCORD_MODEL_PICKER_CUSTOM_ID_KEY}:`)) {
    return null;
  }

  const rawParts = trimmed.split(";");
  const data: Record<string, string> = {};
  for (const part of rawParts) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const rawKey = part.slice(0, equalsIndex);
    const rawValue = part.slice(equalsIndex + 1);
    const key = rawKey.includes(":") ? rawKey.split(":").slice(1).join(":") : rawKey;
    if (!key) {
      continue;
    }
    data[key] = rawValue;
  }

  return parseDiscordModelPickerData(data);
}

export function parseDiscordModelPickerData(data: ComponentData): DiscordModelPickerState | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const command = decodeCustomIdValue(coerceString(data.c ?? data.cmd));
  const action = decodeCustomIdValue(coerceString(data.a ?? data.act));
  const view = decodeCustomIdValue(coerceString(data.v ?? data.view));
  const userId = decodeCustomIdValue(coerceString(data.u));
  const providerRaw = decodeCustomIdValue(coerceString(data.p));
  const runtimeRaw = decodeCustomIdValue(coerceString(data.r));
  const page = parseRawPage(data.g ?? data.pg);
  const providerPage = parseRawPositiveInt(data.pp);
  const modelIndex = parseRawPositiveInt(data.mi);
  const recentSlot = parseRawPositiveInt(data.rs);

  if (!isValidCommandContext(command) || !isValidPickerAction(action) || !isValidPickerView(view)) {
    return null;
  }

  const trimmedUserId = userId.trim();
  if (!trimmedUserId) {
    return null;
  }

  const provider = providerRaw ? normalizeProviderId(providerRaw) : undefined;
  const runtime = runtimeRaw.trim() || undefined;

  return {
    command,
    action,
    view,
    userId: trimmedUserId,
    provider,
    runtime,
    page,
    ...(typeof providerPage === "number" ? { providerPage } : {}),
    ...(typeof modelIndex === "number" ? { modelIndex } : {}),
    ...(typeof recentSlot === "number" ? { recentSlot } : {}),
  };
}

export function buildDiscordModelPickerProviderItems(
  data: ModelsProviderData,
): DiscordModelPickerProviderItem[] {
  return data.providers.map((provider) => ({
    id: provider,
    count: data.byProvider.get(provider)?.size ?? 0,
  }));
}

export function getDiscordModelPickerProviderPage(params: {
  data: ModelsProviderData;
  page?: number;
  pageSize?: number;
}): DiscordModelPickerPage<DiscordModelPickerProviderItem> {
  const items = buildDiscordModelPickerProviderItems(params.data);
  const canFitSinglePage = items.length <= DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX;
  const maxPageSize = canFitSinglePage
    ? DISCORD_MODEL_PICKER_PROVIDER_SINGLE_PAGE_MAX
    : DISCORD_MODEL_PICKER_PROVIDER_PAGE_SIZE;
  const pageSize = clampPageSize(params.pageSize, maxPageSize, maxPageSize);
  return paginateItems({
    items,
    page: normalizePage(params.page),
    pageSize,
  });
}

export function getDiscordModelPickerModelPage(params: {
  data: ModelsProviderData;
  provider: string;
  page?: number;
  pageSize?: number;
}): DiscordModelPickerModelPage | null {
  const provider = normalizeProviderId(params.provider);
  const modelSet = params.data.byProvider.get(provider);
  if (!modelSet) {
    return null;
  }

  const pageSize = clampPageSize(
    params.pageSize,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
    DISCORD_MODEL_PICKER_MODEL_PAGE_SIZE,
  );
  const models = [...modelSet].toSorted();
  const page = paginateItems({
    items: models,
    page: normalizePage(params.page),
    pageSize,
  });

  return {
    ...page,
    provider,
  };
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
  const providerPage = normalizePage(params.providerPage);
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
