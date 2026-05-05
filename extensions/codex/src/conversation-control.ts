import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerApprovalPolicy,
  type CodexAppServerSandboxMode,
} from "./app-server/config.js";
import type { CodexServiceTier, CodexThreadResumeResponse } from "./app-server/protocol.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { getSharedCodexAppServerClient } from "./app-server/shared-client.js";
import { formatCodexDisplayText } from "./command-formatters.js";

type ActiveTurn = {
  sessionFile: string;
  threadId: string;
  turnId: string;
};

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
  activeTurns.set(active.sessionFile, active);
  return () => {
    const current = activeTurns.get(active.sessionFile);
    if (current?.turnId === active.turnId) {
      activeTurns.delete(active.sessionFile);
    }
  };
}

export function readCodexConversationActiveTurn(sessionFile: string): ActiveTurn | undefined {
  return getActiveTurns().get(sessionFile);
}

export async function stopCodexConversationTurn(params: {
  sessionFile: string;
  pluginConfig?: unknown;
}): Promise<{ stopped: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.sessionFile);
  if (!active) {
    return { stopped: false, message: "No active Codex run to stop." };
  }
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile);
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding?.authProfileId,
  });
  await client.request(
    "turn/interrupt",
    {
      threadId: active.threadId,
      turnId: active.turnId,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  return { stopped: true, message: "Codex stop requested." };
}

export async function steerCodexConversationTurn(params: {
  sessionFile: string;
  message: string;
  pluginConfig?: unknown;
}): Promise<{ steered: boolean; message: string }> {
  const active = readCodexConversationActiveTurn(params.sessionFile);
  const text = params.message.trim();
  if (!text) {
    return { steered: false, message: "Usage: /codex steer <message>" };
  }
  if (!active) {
    return { steered: false, message: "No active Codex run to steer." };
  }
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const binding = await readCodexAppServerBinding(params.sessionFile);
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: binding?.authProfileId,
  });
  await client.request(
    "turn/steer",
    {
      threadId: active.threadId,
      expectedTurnId: active.turnId,
      input: [{ type: "text", text, text_elements: [] }],
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
  return { steered: true, message: "Sent steer message to Codex." };
}

export async function setCodexConversationModel(params: {
  sessionFile: string;
  model: string;
  pluginConfig?: unknown;
}): Promise<string> {
  const model = params.model.trim();
  if (!model) {
    return "Usage: /codex model <model>";
  }
  const binding = await requireThreadBinding(params.sessionFile);
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const response = await resumeThreadWithOverrides({
    pluginConfig: params.pluginConfig,
    threadId: binding.threadId,
    authProfileId: binding.authProfileId,
    model,
  });
  await writeCodexAppServerBinding(params.sessionFile, {
    ...binding,
    cwd: response.thread.cwd ?? binding.cwd,
    model: response.model ?? model,
    modelProvider: response.modelProvider ?? binding.modelProvider,
    approvalPolicy: binding.approvalPolicy,
    sandbox: binding.sandbox,
    serviceTier: binding.serviceTier ?? runtime.serviceTier,
  });
  return `Codex model set to ${formatCodexDisplayText(response.model ?? model)}.`;
}

export async function setCodexConversationFastMode(params: {
  sessionFile: string;
  enabled?: boolean;
  pluginConfig?: unknown;
}): Promise<string> {
  const binding = await requireThreadBinding(params.sessionFile);
  if (params.enabled == null) {
    return `Codex fast mode: ${binding.serviceTier === "fast" ? "on" : "off"}.`;
  }
  const serviceTier: CodexServiceTier = params.enabled ? "fast" : "flex";
  // Fast mode is sent on each later turn; do not require Codex to accept an
  // immediate thread/resume control request just to persist the preference.
  await writeCodexAppServerBinding(params.sessionFile, {
    ...binding,
    serviceTier,
  });
  return `Codex fast mode ${params.enabled ? "enabled" : "disabled"}.`;
}

export async function setCodexConversationPermissions(params: {
  sessionFile: string;
  mode?: PermissionsMode;
  pluginConfig?: unknown;
}): Promise<string> {
  const binding = await requireThreadBinding(params.sessionFile);
  if (!params.mode) {
    return `Codex permissions: ${formatPermissionsMode(binding)}.`;
  }
  const policy = permissionsForMode(params.mode);
  // Native bound turns pass these settings at turn/start time, so this command
  // can update the local binding even when app-server resume overrides fail.
  await writeCodexAppServerBinding(params.sessionFile, {
    ...binding,
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

async function requireThreadBinding(sessionFile: string) {
  const binding = await readCodexAppServerBinding(sessionFile);
  if (!binding?.threadId) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  return binding;
}

async function resumeThreadWithOverrides(params: {
  pluginConfig?: unknown;
  threadId: string;
  authProfileId?: string;
  model?: string;
  approvalPolicy?: CodexAppServerApprovalPolicy;
  sandbox?: CodexAppServerSandboxMode;
  serviceTier?: CodexServiceTier;
}): Promise<CodexThreadResumeResponse> {
  const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig: params.pluginConfig });
  const client = await getSharedCodexAppServerClient({
    startOptions: runtime.start,
    timeoutMs: runtime.requestTimeoutMs,
    authProfileId: params.authProfileId,
  });
  return await client.request(
    CODEX_CONTROL_METHODS.resumeThread,
    {
      threadId: params.threadId,
      ...(params.model ? { model: params.model } : {}),
      approvalPolicy: params.approvalPolicy ?? runtime.approvalPolicy,
      sandbox: params.sandbox ?? runtime.sandbox,
      approvalsReviewer: runtime.approvalsReviewer,
      ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
      persistExtendedHistory: true,
    },
    { timeoutMs: runtime.requestTimeoutMs },
  );
}

function permissionsForMode(mode: PermissionsMode): {
  approvalPolicy: CodexAppServerApprovalPolicy;
  sandbox: CodexAppServerSandboxMode;
} {
  return mode === "yolo"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}
