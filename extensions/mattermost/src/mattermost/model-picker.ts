import { createHash } from "node:crypto";
import type { ModelsProviderData } from "openclaw/plugin-sdk/command-auth";
import { resolveStoredModelOverride } from "openclaw/plugin-sdk/command-auth";
import { loadSessionStore, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import type { MattermostInteractiveButtonInput } from "./interactions.js";

const MATTERMOST_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
  providers: "mdlprov",
  list: "mdllist",
  select: "mdlsel",
  back: "mdlback",
} as const;

export type MattermostModelPickerEntry =
  | { kind: "summary" }
  | { kind: "providers" }
  | { kind: "models"; provider: string };

export type MattermostModelPickerState =
  | { action: "providers"; ownerUserId: string }
  | { action: "back"; ownerUserId: string }
  | { action: "list"; ownerUserId: string; provider: string; page: number }
  | { action: "select"; ownerUserId: string; provider: string; page: number; model: string };

export type MattermostModelPickerRenderedView = {
  text: string;
  buttons: MattermostInteractiveButtonInput[][];
};

function splitModelRef(modelRef?: string | null): { provider: string; model: string } | null {
  const trimmed = normalizeOptionalString(modelRef);
  const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
  if (!match) {
    return null;
  }
  const provider = normalizeProviderId(match[1]);
  // Mattermost copy should normalize accidental whitespace around the model.
  const model = normalizeOptionalString(match[2]);
  if (!provider || !model) {
    return null;
  }
  return { provider, model };
}

function readContextString(context: Record<string, unknown>, key: string, fallback = ""): string {
  const value = context[key];
  return typeof value === "string" ? value : fallback;
}

function readContextNumber(context: Record<string, unknown>, key: string): number | undefined {
  const value = context[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizePage(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value as number));
}

function paginateItems<T>(items: T[], page?: number, pageSize = MODELS_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    hasPrev: safePage > 1,
    hasNext: safePage < totalPages,
    totalItems: items.length,
  };
}

function buildContext(state: MattermostModelPickerState): Record<string, unknown> {
  return {
    [MATTERMOST_MODEL_PICKER_CONTEXT_KEY]: true,
    ...state,
  };
}

function buildButtonId(state: MattermostModelPickerState): string {
  const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
  return `${ACTION_IDS[state.action]}${digest}`;
}

function buildButton(params: {
  action: MattermostModelPickerState["action"];
  ownerUserId: string;
  text: string;
  provider?: string;
  page?: number;
  model?: string;
  style?: "default" | "primary" | "danger";
}): MattermostInteractiveButtonInput {
  const baseState =
    params.action === "providers" || params.action === "back"
      ? {
          action: params.action,
          ownerUserId: params.ownerUserId,
        }
      : params.action === "list"
        ? {
            action: "list" as const,
            ownerUserId: params.ownerUserId,
            provider: normalizeProviderId(params.provider ?? ""),
            page: normalizePage(params.page),
          }
        : {
            action: "select" as const,
            ownerUserId: params.ownerUserId,
            provider: normalizeProviderId(params.provider ?? ""),
            page: normalizePage(params.page),
            model: normalizeStringifiedOptionalString(params.model) ?? "",
          };

  return {
    // Mattermost requires action IDs to be unique within a post.
    id: buildButtonId(baseState),
    text: params.text,
    ...(params.style ? { style: params.style } : {}),
    context: buildContext(baseState),
  };
}

function getProviderModels(data: ModelsProviderData, provider: string): string[] {
  return [...(data.byProvider.get(normalizeProviderId(provider)) ?? new Set<string>())].toSorted();
}

function formatCurrentModelLine(currentModel?: string): string {
  const parsed = splitModelRef(currentModel);
  if (!parsed) {
    return "Current: default";
  }
  return `Current: ${parsed.provider}/${parsed.model}`;
}

export function resolveMattermostModelPickerEntry(
  commandText: string,
): MattermostModelPickerEntry | null {
  const normalized = commandText.trim().replace(/\s+/g, " ");
  if (/^\/model$/i.test(normalized)) {
    return { kind: "summary" };
  }
  if (/^\/models$/i.test(normalized)) {
    return { kind: "providers" };
  }
  const providerMatch = normalized.match(/^\/models\s+(\S+)$/i);
  if (!providerMatch?.[1]) {
    return null;
  }
  return {
    kind: "models",
    provider: normalizeProviderId(providerMatch[1]),
  };
}

export function parseMattermostModelPickerContext(
  context: Record<string, unknown>,
): MattermostModelPickerState | null {
  if (!context || context[MATTERMOST_MODEL_PICKER_CONTEXT_KEY] !== true) {
    return null;
  }

  const ownerUserId = normalizeOptionalString(readContextString(context, "ownerUserId")) ?? "";
  const action = normalizeOptionalString(readContextString(context, "action")) ?? "";
  if (!ownerUserId) {
    return null;
  }

  if (action === "providers" || action === "back") {
    return { action, ownerUserId };
  }

  const provider = normalizeProviderId(readContextString(context, "provider"));
  const page = readContextNumber(context, "page");
  if (!provider) {
    return null;
  }

  if (action === "list") {
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page),
    };
  }

  if (action === "select") {
    const model = normalizeOptionalString(readContextString(context, "model")) ?? "";
    if (!model) {
      return null;
    }
    return {
      action,
      ownerUserId,
      provider,
      page: normalizePage(page),
      model,
    };
  }

  return null;
}

export function buildMattermostAllowedModelRefs(data: ModelsProviderData): Set<string> {
  const refs = new Set<string>();
  for (const provider of data.providers) {
    for (const model of data.byProvider.get(provider) ?? []) {
      refs.add(`${provider}/${model}`);
    }
  }
  return refs;
}

export function resolveMattermostModelPickerCurrentModel(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string };
  data: ModelsProviderData;
  skipCache?: boolean;
}): string {
  const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, {
      agentId: params.route.agentId,
    });
    const sessionStore = params.skipCache
      ? loadSessionStore(storePath, { skipCache: true })
      : loadSessionStore(storePath);
    const sessionEntry = sessionStore[params.route.sessionKey];
    const override = resolveStoredModelOverride({
      sessionEntry,
      sessionStore,
      sessionKey: params.route.sessionKey,
      defaultProvider: params.data.resolvedDefault.provider,
    });
    if (!override?.model) {
      return fallback;
    }
    const provider = (override.provider || params.data.resolvedDefault.provider).trim();
    return provider ? `${provider}/${override.model}` : fallback;
  } catch {
    return fallback;
  }
}

export function renderMattermostModelSummaryView(params: {
  ownerUserId: string;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  return {
    text: [
      formatCurrentModelLine(params.currentModel),
      "",
      "Tap below to browse models, or use:",
      "/oc_model <provider/model> to switch",
      "/oc_model status for details",
    ].join("\n"),
    buttons: [
      [
        buildButton({
          action: "providers",
          ownerUserId: params.ownerUserId,
          text: "Browse providers",
          style: "primary",
        }),
      ],
    ],
  };
}

export function renderMattermostProviderPickerView(params: {
  ownerUserId: string;
  data: ModelsProviderData;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  const currentProvider = splitModelRef(params.currentModel)?.provider;
  const rows = params.data.providers.map((provider) => [
    buildButton({
      action: "list",
      ownerUserId: params.ownerUserId,
      text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
      provider,
      page: 1,
      style: provider === currentProvider ? "primary" : "default",
    }),
  ]);

  return {
    text: [formatCurrentModelLine(params.currentModel), "", "Select a provider:"].join("\n"),
    buttons: rows,
  };
}

export function renderMattermostModelsPickerView(params: {
  ownerUserId: string;
  data: ModelsProviderData;
  provider: string;
  page?: number;
  currentModel?: string;
}): MattermostModelPickerRenderedView {
  const provider = normalizeProviderId(params.provider);
  const models = getProviderModels(params.data, provider);
  const current = splitModelRef(params.currentModel);

  if (models.length === 0) {
    return {
      text: [formatCurrentModelLine(params.currentModel), "", `Unknown provider: ${provider}`].join(
        "\n",
      ),
      buttons: [
        [
          buildButton({
            action: "back",
            ownerUserId: params.ownerUserId,
            text: "Back to providers",
          }),
        ],
      ],
    };
  }

  const page = paginateItems(models, params.page);
  const rows: MattermostInteractiveButtonInput[][] = page.items.map((model) => {
    const isCurrent = current?.provider === provider && current.model === model;
    return [
      buildButton({
        action: "select",
        ownerUserId: params.ownerUserId,
        text: isCurrent ? `${model} [current]` : model,
        provider,
        model,
        page: page.page,
        style: isCurrent ? "primary" : "default",
      }),
    ];
  });

  const navRow: MattermostInteractiveButtonInput[] = [];
  if (page.hasPrev) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Prev",
        provider,
        page: page.page - 1,
      }),
    );
  }
  if (page.hasNext) {
    navRow.push(
      buildButton({
        action: "list",
        ownerUserId: params.ownerUserId,
        text: "Next",
        provider,
        page: page.page + 1,
      }),
    );
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([
    buildButton({
      action: "back",
      ownerUserId: params.ownerUserId,
      text: "Back to providers",
    }),
  ]);

  return {
    text: [
      `Models (${provider}) - ${page.totalItems} available`,
      formatCurrentModelLine(params.currentModel),
      `Page ${page.page}/${page.totalPages}`,
      "Select a model to switch immediately.",
    ].join("\n"),
    buttons: rows,
  };
}
