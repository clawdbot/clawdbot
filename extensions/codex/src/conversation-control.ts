// Codex plugin module implements conversation control behavior.
import { ModelSelectionLockedError } from "openclaw/plugin-sdk/model-session-runtime";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  isCodexFastServiceTier,
  resolveCodexModelBackedReviewerPolicyContext,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./app-server/config.js";
import type { CodexServiceTier, CodexThreadResumeResponse } from "./app-server/protocol.js";
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
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: connection.clientAuthProfileId,
    ...lookup,
  });
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
    releaseLeasedSharedCodexAppServerClient(client);
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
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: connection.clientAuthProfileId,
    ...lookup,
  });
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
    releaseLeasedSharedCodexAppServerClient(client);
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
  const reviewerPolicyContext = resolveCodexModelBackedReviewerPolicyContext({
    provider: "codex",
    model,
    bindingModelProvider: binding.modelProvider,
    bindingModel: binding.model,
    nativeAuthProfile: isCodexAppServerNativeAuthProfile({
      authProfileId: binding.authProfileId,
      ...lookup,
    }),
  });
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.pluginConfig,
    modelProvider: reviewerPolicyContext.modelProvider,
    model: reviewerPolicyContext.model,
    config: params.config,
    agentDir: params.agentDir,
  });
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
  const response = await resumeThreadWithOverrides({
    runtime,
    threadId: binding.threadId,
    authProfileId: binding.authProfileId,
    ...lookup,
    model: modelSelection.model,
    modelProvider: modelSelection.modelProvider,
  });
  const nextModel = response.model ?? modelSelection.model;
  const nextModelProvider = normalizeCodexAppServerBindingModelProvider({
    authProfileId: binding.authProfileId,
    modelProvider: response.modelProvider ?? modelSelection.modelProvider,
    ...lookup,
  });
  const modelChanged = nextModel !== binding.model || nextModelProvider !== binding.modelProvider;
  await patchThreadBinding(params.bindingStore, params.identity, binding.threadId, {
    cwd: response.thread.cwd ?? binding.cwd,
    model: nextModel,
    modelProvider: nextModelProvider,
    ...(modelChanged && binding.contextEngine?.projection
      ? { contextEngine: { ...binding.contextEngine, projection: undefined } }
      : {}),
    approvalPolicy: binding.approvalPolicy,
    sandbox: binding.sandbox,
    serviceTier: binding.serviceTier ?? runtime.serviceTier ?? undefined,
  });
  return `Codex model set to ${formatCodexDisplayText(response.model ?? model)}.`;
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
  identity: CodexAppServerBindingIdentity;
  bindingStore: CodexAppServerBindingStore;
  mode?: PermissionsMode;
  pluginConfig?: unknown;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
}): Promise<string> {
  const binding = await requireThreadBinding(params.bindingStore, params.identity);
  if (!params.mode) {
    return `Codex permissions: ${formatPermissionsMode(binding)}.`;
  }
  const policy = permissionsForMode(params.mode);
  // Native bound turns pass these settings at turn/start time, so this command
  // can update the local binding even when app-server resume overrides fail.
  await patchThreadBinding(params.bindingStore, params.identity, binding.threadId, {
    approvalPolicy: policy.approvalPolicy,
    sandbox: policy.sandbox,
  });
  return `Codex permissions set to ${params.mode === "yolo" ? "full access" : "default"}.`;
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
  if (normalized === "default" || normalized === "guardian") {
    return "default";
  }
  return undefined;
}

export function formatPermissionsMode(binding: {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
}): string {
  return binding.approvalPolicy === "never" && binding.sandbox === "danger-full-access"
    ? "full access"
    : "default";
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

async function resumeThreadWithOverrides(params: {
  runtime: ReturnType<typeof resolveCodexAppServerRuntimeOptions>;
  threadId: string;
  authProfileId?: string;
  agentDir?: string;
  config?: CodexAppServerBindingLookup["config"];
  model?: string;
  modelProvider?: string | null;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
}): Promise<CodexThreadResumeResponse> {
  const runtime = params.runtime;
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
    ...buildBindingLookup(params),
  });
  try {
    return await client.request(
      CODEX_CONTROL_METHODS.resumeThread,
      {
        threadId: params.threadId,
        ...(params.model ? { model: params.model } : {}),
        ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
        approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
        sandbox: params.sandbox ?? runtime.sandbox,
        approvalsReviewer: runtime.approvalsReviewer,
        ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
      },
      { timeoutMs: runtime.requestTimeoutMs },
    );
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
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

function permissionsForMode(mode: PermissionsMode): {
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
} {
  return mode === "yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}
