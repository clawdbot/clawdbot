import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
import {
  resolveProviderChannelLoginChoice,
  type ProviderChannelLoginChoice,
} from "../plugins/provider-login-options.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { OpenClawConfig } from "./config-contracts.js";
import type { RuntimeEnv } from "./runtime-env.js";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../commands/models/auth.js";
export type { ProviderChannelLoginChoice } from "../plugins/provider-login-options.js";

type ProviderAuthLoginFlowRuntime = typeof import("../commands/models/auth.js");

export type ProviderLoginSessionEntry = {
  sessionId: string;
  providerOverride?: string;
  modelProvider?: string;
  authProfileOverride?: string;
  authProfileOverrideSource?: "auto" | "user";
  authProfileOverrideCompactionCount?: number;
};

export type ProviderLoginSessionAdoption =
  | { status: "unchanged" }
  | {
      status: "patch";
      patch: {
        authProfileOverride: string;
        authProfileOverrideSource: "user";
        authProfileOverrideCompactionCount: undefined;
      };
    }
  | { status: "rejected" };

const PROVIDER_LOGIN_FLOW_TTL_MS = 15 * 60_000;

type ProviderLoginFlowRecord = {
  expiresAt: number;
  signal: AbortSignal;
  cancel: () => void;
};

type ProviderLoginFlowReservation =
  | { status: "active" }
  | { status: "reserved"; record: ProviderLoginFlowRecord };

export function createProviderLoginFlowRegistry(): Map<string, ProviderLoginFlowRecord> {
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

export function hasConfiguredCommandOwnerAllowlist(cfg: OpenClawConfig): boolean {
  const owners = cfg.commands?.ownerAllowFrom;
  return Array.isArray(owners) && owners.some((owner) => normalizeOptionalString(String(owner)));
}

function matchesLoginSnapshot(
  current: ProviderLoginSessionEntry,
  snapshot: ProviderLoginSessionEntry,
): boolean {
  return (
    current.sessionId === snapshot.sessionId &&
    current.authProfileOverride === snapshot.authProfileOverride &&
    current.authProfileOverrideSource === snapshot.authProfileOverrideSource &&
    current.authProfileOverrideCompactionCount === snapshot.authProfileOverrideCompactionCount
  );
}

function resolvePersistedModelProvider(entry: ProviderLoginSessionEntry): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(entry.providerOverride ?? entry.modelProvider);
  return provider || undefined;
}

/** Decide one session-profile adoption from the authoritative row read immediately before write. */
export function decideProviderLoginSessionAdoption(params: {
  currentModelProvider: string | undefined;
  loginProvider: string;
  nextProfileId: string | undefined;
  snapshot: ProviderLoginSessionEntry | undefined;
  current: ProviderLoginSessionEntry | undefined;
}): ProviderLoginSessionAdoption {
  if (!params.nextProfileId) {
    return { status: "rejected" };
  }
  if (
    !params.currentModelProvider ||
    normalizeLowercaseStringOrEmpty(params.currentModelProvider) !==
      normalizeLowercaseStringOrEmpty(params.loginProvider) ||
    !params.current
  ) {
    return { status: "unchanged" };
  }
  const currentProvider = resolvePersistedModelProvider(params.current);
  const snapshotProvider = params.snapshot
    ? resolvePersistedModelProvider(params.snapshot)
    : undefined;
  if (
    (currentProvider &&
      currentProvider !== normalizeLowercaseStringOrEmpty(params.loginProvider)) ||
    (params.snapshot && currentProvider !== snapshotProvider)
  ) {
    return { status: "unchanged" };
  }
  if (params.snapshot) {
    if (!matchesLoginSnapshot(params.current, params.snapshot)) {
      return { status: "rejected" };
    }
  } else {
    const source =
      params.current.authProfileOverrideSource ??
      (typeof params.current.authProfileOverrideCompactionCount === "number"
        ? "auto"
        : params.current.authProfileOverride
          ? "user"
          : undefined);
    if (source === "user" && params.current.authProfileOverride !== params.nextProfileId) {
      return { status: "rejected" };
    }
  }
  const needsPatch =
    params.current.authProfileOverride !== params.nextProfileId ||
    params.current.authProfileOverrideSource !== "user" ||
    params.current.authProfileOverrideCompactionCount !== undefined;
  return needsPatch
    ? {
        status: "patch",
        patch: {
          authProfileOverride: params.nextProfileId,
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: undefined,
        },
      }
    : { status: "unchanged" };
}

export function reserveProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  now?: number;
  replacementMessage?: string;
}): ProviderLoginFlowReservation {
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
    expiresAt: now + PROVIDER_LOGIN_FLOW_TTL_MS,
    signal: abortController.signal,
    cancel: () =>
      abortController.abort(
        new Error(params.replacementMessage ?? "Provider login was replaced by a newer flow."),
      ),
  };
  params.flows.set(params.flowKey, record);
  return { status: "reserved", record };
}

export function releaseProviderLoginFlow(params: {
  flows: Map<string, ProviderLoginFlowRecord>;
  flowKey: string;
  record: ProviderLoginFlowRecord;
}): void {
  if (params.flows.get(params.flowKey) === params.record) {
    params.flows.delete(params.flowKey);
  }
}

function buildProviderChannelLoginPrompter(params: {
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
    await sendCleanMessage(params.unsupportedPromptMessage);
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

export async function runProviderChannelLoginFlow(params: {
  choice: ProviderChannelLoginChoice;
  agentId: string;
  profileId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  sendMessage: (message: string) => Promise<void>;
  sendDeviceCode?: NonNullable<ModelsAuthLoginFlowOptions["prompter"]["deviceCode"]>;
  signal?: AbortSignal;
  unsupportedPromptMessage: string;
}): Promise<ModelsAuthLoginFlowResult> {
  return await runModelsAuthLoginFlow({
    provider: params.choice.providerId,
    method: params.choice.methodId,
    ownerPluginId: params.choice.pluginId,
    credentialOnly: true,
    agent: params.agentId,
    ...(params.profileId ? { profileId: params.profileId } : {}),
    config: params.config,
    runtime: params.runtime,
    signal: params.signal,
    prompter: buildProviderChannelLoginPrompter({
      sendMessage: params.sendMessage,
      sendDeviceCode: params.sendDeviceCode,
      signal: params.signal,
      unsupportedPromptMessage: params.unsupportedPromptMessage,
    }),
    isRemote: true,
    openUrl: async () => {},
  });
}

export function formatProviderLoginCommand(choice: ProviderChannelLoginChoice): string {
  return `/login ${choice.command}`;
}

export function formatProviderLoginComplete(
  choice: ProviderChannelLoginChoice,
  imported: boolean,
  modelAccess: ModelsAuthLoginFlowResult["modelAccess"],
  authRefresh: ModelsAuthLoginFlowResult["authRefresh"],
): string {
  const login = imported
    ? `${choice.providerLabel} login complete using your existing CLI sign-in.`
    : `${choice.providerLabel} login complete.`;
  if (modelAccess === "failed") {
    return `${login} Your credential is saved, but OpenClaw could not enable its models. Retry ${formatProviderLoginCommand(choice)} after the current config change finishes.`;
  }
  if (authRefresh === "gateway-rejected") {
    return `${login} Your credential is saved, but this Gateway rejected the auth refresh. Check the Gateway logs, then use /models.`;
  }
  if (authRefresh === "gateway-unreachable") {
    return `${login} Your credential is saved, but this Gateway could not refresh its model catalog. Restart the Gateway, then use /models.`;
  }
  if (modelAccess === "enabled") {
    return `${login} Available ${choice.providerLabel} models will update automatically. Your default model is unchanged. Use /models to browse.`;
  }
  return `${login} Try your request again now.`;
}

export function formatProviderLoginSessionSwitchFailed(
  choice: ProviderChannelLoginChoice,
  sessionLabel = "session",
): string {
  return `${choice.providerLabel} login completed, but this ${sessionLabel} could not switch to the newly authenticated profile. Retry \`${formatProviderLoginCommand(choice)}\`, or select the profile manually.`;
}

export function formatProviderLoginFailed(choice: ProviderChannelLoginChoice): string {
  return `${choice.providerLabel} login did not complete. Send \`${formatProviderLoginCommand(choice)}\` to try again.`;
}

export function formatProviderLoginControlUiHandoff(choice: ProviderChannelLoginChoice): string {
  if (choice.mode === "setup") {
    return `${choice.label} needs provider setup. Open Control UI → Models → Connect, then choose “${choice.label}” under Provider setup.`;
  }
  return choice.mode === "secret"
    ? `${choice.label} needs secure input that chat must not store. Open Control UI → Models → Connect, then choose “${choice.label}” under Connect with an API key or token.`
    : `${choice.label} needs provider sign-in. Open Control UI → Models → Connect, then choose “${choice.label}” under Sign in.`;
}

export function formatProviderLoginChoices(choices: ProviderChannelLoginChoice[]): string {
  const visible = choices
    .toSorted((a, b) => Number(b.mode === "chat") - Number(a.mode === "chat"))
    .slice(0, 8);
  const commands = visible.map((choice) => `\`${formatProviderLoginCommand(choice)}\``).join(", ");
  const remaining = choices.length - visible.length;
  return remaining > 0 ? `${commands}, and ${remaining} more in Control UI → Models` : commands;
}

export { resolveProviderChannelLoginChoice };

/** A persisted row proves a patch only when it carries the exact login profile we wrote. */
export function isProviderLoginPatchPersisted(
  persisted: ProviderLoginSessionEntry,
  nextProfileId: string,
): boolean {
  return (
    persisted.authProfileOverride === nextProfileId &&
    persisted.authProfileOverrideSource === "user" &&
    persisted.authProfileOverrideCompactionCount === undefined
  );
}
