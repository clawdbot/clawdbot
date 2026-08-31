// Codex plugin module implements conversation control behavior.
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyModelOverrideWithAuthProfileCompatibility,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import type { CodexAppServerClient } from "./app-server/client.js";
import { isCodexFastServiceTier } from "./app-server/config.js";
import type { CodexServiceTier } from "./app-server/protocol.js";
import {
  bindingStoreKey,
  isCodexAppServerNativeAuthProfile,
  normalizeCodexAppServerBindingModelProvider,
  type CodexAppServerAuthProfileLookup,
  type CodexAppServerBindingIdentity,
  type CodexAppServerBindingStore,
} from "./app-server/session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import {
  resolveCodexAppServerRequestModelSelection,
  resolveCodexBindingModelProviderFallback,
} from "./app-server/thread-lifecycle.js";
import { formatCodexDisplayText } from "./command-formatters.js";

type ActiveTurn = {
  identity: CodexAppServerBindingIdentity;
  client?: CodexAppServerClient;
  threadId: string;
  turnId: string;
};

type CodexAppServerBindingLookup = Omit<CodexAppServerAuthProfileLookup, "authProfileId">;

type PermissionsMode = "default" | "yolo";

const CODEX_CONVERSATION_CONTROL_STATE = Symbol.for("openclaw.codex.conversationControl");

function getActiveTurns(): Map<string, ActiveTurn> {
  const globalState = globalThis as typeof globalThis & {
    [CODEX_CONVERSATION_CONTROL_STATE]?: Map<string, ActiveTurn>;
  };
  globalState[CODEX_CONVERSATION_CONTROL_STATE] ??= new Map();
  return globalState[CODEX_CONVERSATION_CONTROL_STATE];
}

export function trackCodexConversationActiveTurn(active: ActiveTurn): () => void {
  const activeTurns = getActiveTurns();
  const key = bindingStoreKey(active.identity);
  activeTurns.set(key, active);
  return () => {
    const current = activeTurns.get(key);
    if (current?.turnId === active.turnId) {
      activeTurns.delete(key);
    }
  };
}

export function readCodexConversationActiveTurn(
  identity: CodexAppServerBindingIdentity,
): ActiveTurn | undefined {
  return getActiveTurns().get(bindingStoreKey(identity));
}

export async function stopCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<{ stopped: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  if (!active) {
    return { stopped: false, message: "No active Codex run to stop." };
  }
  const lookup = buildBindingLookup(params);
  const binding = await params.bindingStore.read(params.identity);
  if (binding?.threadId !== active.threadId) {
    return {
      stopped: false,
      message: "The active Codex run no longer matches this session binding.",
    };
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding?.authProfileId,
    pluginConfig: params.pluginConfig,
  });
  const runtime = connection.appServer;
  // Turn ids are connection-local. Prefer the exact live client; ID-only
  // records must resolve the binding-owned connection before dispatch.
  const client =
    active.client ??
    (await getLeasedSharedCodexAppServerClient({
      startOptions: runtime.start,
      timeoutMs: runtime.requestTimeoutMs,
      authProfileId: connection.clientAuthProfileId,
      ...lookup,
    }));
  try {
    await client.request(
      "turn/interrupt",
      {
        threadId: active.threadId,
        turnId: active.turnId,
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    if (!active.client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
  return { stopped: true, message: "Codex stop requested." };
}

export async function steerCodexConversationTurn(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  message: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<{ steered: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.identity);
  const text = params.message.trim();
  if (!text) {
    return { steered: false, message: "Usage: /codex steer <message>" };
  }
  if (!active) {
    return { steered: false, message: "No active Codex run to steer." };
  }
  const lookup = buildBindingLookup(params);
  const binding = await params.bindingStore.read(params.identity);
  if (binding?.threadId !== active.threadId) {
    return {
      steered: false,
      message: "The active Codex run no longer matches this session binding.",
    };
  }
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    authProfileId: binding?.authProfileId,
    pluginConfig: params.pluginConfig,
  });
  const runtime = connection.appServer;
  // Turn ids are connection-local. Prefer the exact live client; ID-only
  // records must resolve the binding-owned connection before dispatch.
  const client =
    active.client ??
    (await getLeasedSharedCodexAppServerClient({
      startOptions: runtime.start,
      timeoutMs: runtime.requestTimeoutMs,
      authProfileId: connection.clientAuthProfileId,
      ...lookup,
    }));
  try {
    await client.request(
      "turn/steer",
      {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: [{ type: "text", text, text_elements: [] }],
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    if (!active.client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
  return { steered: true, message: "Sent steer message to Codex." };
}

export async function setCodexConversationModel(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  model: string;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const model = params.model.trim();
  if (!model) {
    return "Usage: /codex model <model>";
  }
  const lookup = buildBindingLookup(params);
  const binding = await requireThreadBinding(params.bindingStore, params.identity);
  if (binding.connectionScope === "supervision") {
    throw new ModelSelectionLockedError();
  }
  const modelProvider = resolveConversationControlModelProvider({
    authProfileId: binding.authProfileId,
    bindingModel: binding.model,
    bindingModelProvider: binding.modelProvider,
    currentModel: model,
    ...lookup,
  });
  const modelSelection = resolveCodexAppServerRequestModelSelection({
    model,
    modelProvider,
    authProfileId: binding.authProfileId,
    ...lookup,
  });
  const nextModelProvider = normalizeCodexAppServerBindingModelProvider({
    authProfileId: binding.authProfileId,
    modelProvider: modelSelection.modelProvider,
    ...lookup,
  });
  const nextModel = modelSelection.model;
  const modelChanged = nextModel !== binding.model || nextModelProvider !== binding.modelProvider;
  const projectionPatch =
    modelChanged && binding.contextEngine?.projection
      ? { contextEngine: { ...binding.contextEngine, projection: undefined } }
      : {};
  const identity = params.identity;
  if (identity.kind === "session" && identity.sessionKey) {
    // SessionEntry owns the desired model; retain the loaded binding until
    // lifecycle reconciliation can rotate its native generation safely.
    const updated = await patchSessionEntry({
      agentId: identity.agentId,
      storePath: resolveStorePath(params.config?.session?.store, { agentId: identity.agentId }),
      sessionKey: identity.sessionKey,
      requireWriteSuccess: true,
      replaceEntry: true,
      update: (entry) => {
        if (entry.sessionId !== identity.sessionId) {
          throw new Error("Codex session changed while applying the model selection.");
        }
        applyModelOverrideWithAuthProfileCompatibility({
          cfg: params.config ?? {},
          agentDir: params.agentDir ?? resolveAgentDir(params.config ?? {}, identity.agentId),
          entry,
          currentProvider: binding.modelProvider ?? "openai",
          selection: { provider: nextModelProvider ?? "openai", model: nextModel },
          markLiveSwitchPending: true,
        });
        return entry;
      },
    });
    if (!updated) {
      throw new Error("Codex session changed while applying the model selection.");
    }
    if (modelChanged && binding.contextEngine?.projection) {
      await patchThreadBinding(params.bindingStore, identity, binding.threadId, projectionPatch);
    }
  } else {
    // Conversation bindings and ephemeral sessions own native selection;
    // ambient outer-session metadata must never redirect their runtime.
    await patchThreadBinding(params.bindingStore, params.identity, binding.threadId, {
      model: nextModel,
      modelProvider: nextModelProvider,
      ...projectionPatch,
    });
  }
  return `Codex model set to ${formatCodexDisplayText(nextModel)}.`;
}

export async function setCodexConversationFastMode(params: {
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  enabled?: boolean;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const binding = await requireThreadBinding(params.bindingStore, params.identity);
  if (params.enabled == null) {
    return `Codex fast mode: ${isCodexFastServiceTier(binding.serviceTier) ? "on" : "off"}.`;
  }
  const serviceTier: CodexServiceTier = params.enabled ? "priority" : "flex";
  // Fast mode is sent on each later turn; do not require Codex to accept an
  // immediate thread/resume control request just to persist the preference.
  await patchThreadBinding(params.bindingStore, params.identity, binding.threadId, { serviceTier });
  return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}

export async function setCodexConversationPermissions(params: {
  mode?: PermissionsMode;
  config?: CodexAppServerBindingLookup["config"];
  session: { agentId: string; sessionId: string; sessionKey: string };
}): Promise<string> {
  const storePath = resolveStorePath(params.config?.session?.store, {
    agentId: params.session.agentId,
  });
  if (!params.mode) {
    const entry = getSessionEntry({
      agentId: params.session.agentId,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey: params.session.sessionKey,
      storePath,
    });
    if (entry?.sessionId !== params.session.sessionId) {
      throw new Error("Codex session changed while reading the permission mode.");
    }
    return `Codex permissions: ${formatPermissionsMode(entry.permissionMode)}.`;
  }
  const updated = await patchSessionEntry({
    agentId: params.session.agentId,
    storePath,
    sessionKey: params.session.sessionKey,
    requireWriteSuccess: true,
    replaceEntry: true,
    update: (entry) => {
      if (entry.sessionId !== params.session.sessionId) {
        throw new Error("Codex session changed while applying the permission mode.");
      }
      entry.permissionMode = params.mode === "yolo" ? "full" : "guarded";
      return entry;
    },
  });
  if (!updated) {
    throw new Error("Codex session changed while applying the permission mode.");
  }
  return `Codex permissions set to ${params.mode === "yolo" ? "full access" : "guarded"}.`;
}

export function parseCodexFastModeArg(arg: string | undefined): boolean | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return undefined;
  }
  if (normalized === "on" || normalized === "true" || normalized === "fast") {
    return true;
  }
  if (normalized === "off" || normalized === "false" || normalized === "flex") {
    return false;
  }
  return undefined;
}

export function parseCodexPermissionsModeArg(arg: string | undefined): PermissionsMode | undefined {
  const normalized = arg?.trim().toLowerCase();
  if (!normalized || normalized === "status") {
    return undefined;
  }
  if (normalized === "yolo" || normalized === "full" || normalized === "full-access") {
    return "yolo";
  }
  if (["default", "guardian", "guarded", "approve"].includes(normalized)) {
    return "default";
  }
  return undefined;
}

export function formatPermissionsMode(
  mode: "read-only" | "guarded" | "workspace" | "full" | undefined,
): string {
  return mode === "full" ? "full access" : (mode ?? "default");
}

async function requireThreadBinding(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
) {
  const binding = await bindingStore.read(identity);
  if (!binding?.threadId) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  return binding;
}

async function patchThreadBinding(
  bindingStore: CodexAppServerBindingStore,
  identity: CodexAppServerBindingIdentity,
  threadId: string,
  patch: Extract<Parameters<CodexAppServerBindingStore["mutate"]>[1], { kind: "patch" }>["patch"],
): Promise<void> {
  if (!(await bindingStore.mutate(identity, { kind: "patch", threadId, patch }))) {
    throw new Error("Codex thread binding changed while applying the control update.");
  }
}

function buildBindingLookup(params: {
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): CodexAppServerBindingLookup {
  const agentDir = params.agentDir?.trim();
  return {
    ...(agentDir ? { agentDir } : {}),
    ...(params.config ? { config: params.config } : {}),
  };
}

function resolveConversationControlModelProvider(params: {
  authProfileId?: string;
  bindingModel?: string;
  bindingModelProvider?: string;
  currentModel?: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): string | undefined {
  const modelProvider = resolveCodexBindingModelProviderFallback({
    currentModel: params.currentModel,
    bindingModel: params.bindingModel,
    bindingModelProvider: params.bindingModelProvider,
  })?.trim();
  if (!modelProvider || modelProvider.toLowerCase() === "codex") {
    return undefined;
  }
  if (isCodexAppServerNativeAuthProfile(params) && modelProvider.toLowerCase() === "openai") {
    return undefined;
  }
  return modelProvider.toLowerCase() === "openai" ? "openai" : modelProvider;
}
