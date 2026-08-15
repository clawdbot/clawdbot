import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");
type RunModelsAuthLoginFlow = (opts: ModelsAuthLoginFlowOptions) => Promise<unknown>;

const CODEX_LOGIN_PROVIDER = "openai";
const CODEX_LOGIN_METHOD = "device-code";
const CODEX_LOGIN_FLOW_TTL_MS = 15 * 60_000;

const CODEX_LOGIN_PROVIDER_ALIASES = new Set(["codex", "openai"]);

type CodexLoginFlowRecord = {
  expiresAt: number;
  signal: AbortSignal;
  cancel: () => void;
};

type CodexLoginFlowReservation =
  | { status: "active" }
  | { status: "reserved"; record: CodexLoginFlowRecord };

function createCodexLoginFlowRegistry(): Map<string, CodexLoginFlowRecord> {
  return new Map();
}

const loadProviderAuthLoginFlowRuntime = createLazyRuntimeModule(
  () => import("../commands/models/auth.js"),
);
const bindProviderAuthLoginFlowRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthLoginFlowRuntime,
);

export const runModelsAuthLoginFlow: ProviderAuthLoginFlowRuntime["runModelsAuthLoginFlowCore"] =
  bindProviderAuthLoginFlowRuntime((runtime) => runtime.runModelsAuthLoginFlowCore);

function resolveCodexLoginProvider(rawProvider: string | undefined): string | null {
  const normalized = normalizeLowercaseStringOrEmpty(rawProvider ?? "codex").replace(/_/gu, "-");
  if (!normalized) {
    return CODEX_LOGIN_PROVIDER;
  }
  return CODEX_LOGIN_PROVIDER_ALIASES.has(normalized) ? CODEX_LOGIN_PROVIDER : null;
}

function hasConfiguredCommandOwnerAllowlist(cfg: OpenClawConfig): boolean {
  const owners = cfg.commands?.ownerAllowFrom;
  return Array.isArray(owners) && owners.some((owner) => normalizeOptionalString(String(owner)));
}

function resolveProviderScopedProfileId(
  authProfileOverride: string | undefined,
  provider: string,
): string | undefined {
  const profileId = normalizeOptionalString(authProfileOverride);
  if (!profileId) {
    return undefined;
  }
  const providerPrefix = `${normalizeLowercaseStringOrEmpty(provider)}:`;
  return normalizeLowercaseStringOrEmpty(profileId).startsWith(providerPrefix)
    ? profileId
    : undefined;
}

function reserveCodexLoginFlow(params: {
  flows: Map<string, CodexLoginFlowRecord>;
  flowKey: string;
  now?: number;
}): CodexLoginFlowReservation {
  const now = params.now ?? Date.now();
  const activeFlow = params.flows.get(params.flowKey);
  if (activeFlow && activeFlow.expiresAt > now) {
    return { status: "active" };
  }
  if (activeFlow) {
    activeFlow.cancel();
    params.flows.delete(params.flowKey);
  }
  const abortController = new AbortController();
  const record = {
    expiresAt: now + CODEX_LOGIN_FLOW_TTL_MS,
    signal: abortController.signal,
    cancel: () => abortController.abort(new Error("Codex login was replaced by a newer flow.")),
  };
  params.flows.set(params.flowKey, record);
  return { status: "reserved", record };
}

function releaseCodexLoginFlow(params: {
  flows: Map<string, CodexLoginFlowRecord>;
  flowKey: string;
  record: CodexLoginFlowRecord;
}): void {
  if (params.flows.get(params.flowKey) === params.record) {
    params.flows.delete(params.flowKey);
  }
}

function buildCodexDeviceLoginPrompter(params: {
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
}): ModelsAuthLoginFlowOptions["prompter"] {
  const sendCleanMessage = async (message: string) => {
    params.signal?.throwIfAborted();
    const text = message.trim();
    if (text) {
      await params.sendMessage(text);
      params.signal?.throwIfAborted();
    }
  };
  const sendDeviceCode = params.sendDeviceCode;
  const unsupportedPrompt = async () => {
    throw new Error(params.unsupportedPromptMessage);
  };
  return {
    intro: async () => {},
    outro: async () => {},
    note: async (message, title) => {
      await sendCleanMessage([title?.trim(), message.trim()].filter(Boolean).join("\n\n"));
    },
    ...(sendDeviceCode
      ? {
          deviceCode: async (deviceCode) => {
            params.signal?.throwIfAborted();
            await sendDeviceCode(deviceCode);
            params.signal?.throwIfAborted();
          },
        }
      : {}),
    plain: sendCleanMessage,
    select: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["select"],
    multiselect: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["multiselect"],
    text: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["text"],
    confirm: unsupportedPrompt as ModelsAuthLoginFlowOptions["prompter"]["confirm"],
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };
}

function parseModelsAuthLoginFlowResult(value: unknown): ModelsAuthLoginFlowResult {
  if (!value || typeof value !== "object") {
    throw new Error("Provider login returned an invalid result.");
  }
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.profiles)) {
    throw new Error("Provider login returned an invalid result.");
  }
  const parseRequiredString = (input: unknown, label: string): string => {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error(`Provider login returned an invalid ${label}.`);
    }
    return input.trim();
  };
  const providerId = parseRequiredString(result.providerId, "provider id");
  const methodId = parseRequiredString(result.methodId, "method id");
  const profiles = result.profiles.map((profile): ModelsAuthLoginFlowResult["profiles"][number] => {
    if (!profile || typeof profile !== "object") {
      throw new Error("Provider login returned an invalid profile.");
    }
    const record = profile as Record<string, unknown>;
    const profileId = parseRequiredString(record.profileId, "profile id");
    const provider = parseRequiredString(record.provider, "profile provider");
    const mode = parseRequiredString(record.mode, "profile mode");
    if (mode !== "api_key" && mode !== "oauth" && mode !== "token") {
      throw new Error("Provider login returned an invalid profile.");
    }
    return {
      profileId,
      provider,
      mode,
    };
  });
  const defaultModel =
    result.defaultModel === undefined
      ? undefined
      : parseRequiredString(result.defaultModel, "default model");
  return {
    providerId,
    methodId,
    ...(defaultModel ? { defaultModel } : {}),
    profiles,
  };
}

async function runCodexDeviceLoginFlow(params: {
  provider: string;
  agentId: string;
  profileId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
  runLoginFlow?: RunModelsAuthLoginFlow;
}): Promise<ModelsAuthLoginFlowResult> {
  const result = await (params.runLoginFlow ?? runModelsAuthLoginFlow)({
    provider: params.provider,
    method: CODEX_LOGIN_METHOD,
    agent: params.agentId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
    config: params.config,
    runtime: params.runtime,
    signal: params.signal,
    prompter: buildCodexDeviceLoginPrompter({
      sendMessage: params.sendMessage,
      sendDeviceCode: params.sendDeviceCode,
      signal: params.signal,
      unsupportedPromptMessage: params.unsupportedPromptMessage,
    }),
    isRemote: true,
    openUrl: async () => {},
  });
  return parseModelsAuthLoginFlowResult(result);
}

export const codexChannelLoginRuntime = {
  createFlowRegistry: createCodexLoginFlowRegistry,
  resolveProvider: resolveCodexLoginProvider,
  hasConfiguredCommandOwnerAllowlist,
  resolveProviderScopedProfileId,
  reserveFlow: reserveCodexLoginFlow,
  releaseFlow: releaseCodexLoginFlow,
  runDeviceLoginFlow: runCodexDeviceLoginFlow,
};
