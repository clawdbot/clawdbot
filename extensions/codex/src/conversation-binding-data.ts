// Codex plugin module implements conversation binding data behavior.
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import type { PluginConversationBinding } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const APP_SERVER_BINDING_DATA_VERSION = 2;
const CLI_BINDING_DATA_VERSION = 1;

export type CodexAppServerConversationBindingData = {
  kind: "codex-app-server-session";
  version: 2;
  bindingId: string;
  workspaceDir: string;
  agentId?: string;
  agentDir?: string;
  source?: CodexAppServerConversationSource;
  start?: CodexAppServerConversationStart;
  legacyBinding?: true;
};

type CodexAppServerConversationSource = {
  agentId: string;
  sessionId: string;
  threadId: string;
  sessionKey?: string;
};

type CodexAppServerConversationStart = {
  id: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
};

type CodexCliNodeConversationBindingData = {
  kind: "codex-cli-node-session";
  version: 1;
  nodeId: string;
  sessionId: string;
  agentId?: string;
  cwd?: string;
};

type CodexConversationBindingData =
  | CodexAppServerConversationBindingData
  | CodexCliNodeConversationBindingData;

export function createCodexConversationBindingData(params: {
  bindingId?: string;
  workspaceDir: string;
  agentId?: string;
  agentDir?: string;
  source?: CodexAppServerConversationSource;
  start?: CodexAppServerConversationStart;
}): CodexAppServerConversationBindingData {
  const agentId = params.agentId?.trim();
  const agentDir = params.agentDir?.trim();
  const source = readConversationSource(params.source);
  const start = readConversationStart(params.start);
  return {
    kind: "codex-app-server-session",
    version: APP_SERVER_BINDING_DATA_VERSION,
    bindingId: params.bindingId?.trim() || randomUUID(),
    workspaceDir: params.workspaceDir,
    ...(agentId ? { agentId } : {}),
    ...(agentDir ? { agentDir } : {}),
    ...(source ? { source } : {}),
    ...(start ? { start } : {}),
  };
}

export function createCodexCliNodeConversationBindingData(params: {
  nodeId: string;
  sessionId: string;
  agentId?: string;
  cwd?: string;
}): CodexCliNodeConversationBindingData {
  const agentId = params.agentId?.trim();
  const cwd = params.cwd?.trim();
  return {
    kind: "codex-cli-node-session",
    version: CLI_BINDING_DATA_VERSION,
    nodeId: params.nodeId,
    sessionId: params.sessionId,
    ...(agentId ? { agentId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

export function readCodexConversationBindingData(
  binding: PluginConversationBinding | null | undefined,
): CodexConversationBindingData | undefined {
  const data = binding?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return undefined;
  }
  return readCodexConversationBindingDataRecord(data);
}

export function readCodexConversationBindingDataRecord(
  data: Record<string, unknown>,
): CodexConversationBindingData | undefined {
  if (data.kind === "codex-cli-node-session") {
    if (
      data.version !== CLI_BINDING_DATA_VERSION ||
      typeof data.nodeId !== "string" ||
      !data.nodeId.trim() ||
      typeof data.sessionId !== "string" ||
      !data.sessionId.trim()
    ) {
      return undefined;
    }
    return {
      kind: "codex-cli-node-session",
      version: CLI_BINDING_DATA_VERSION,
      nodeId: data.nodeId.trim(),
      sessionId: data.sessionId.trim(),
      agentId:
        typeof data.agentId === "string" && data.agentId.trim() ? data.agentId.trim() : undefined,
      cwd: typeof data.cwd === "string" && data.cwd.trim() ? data.cwd.trim() : undefined,
    };
  }
  if (data.kind !== "codex-app-server-session") {
    return undefined;
  }
  const bindingId =
    data.version === APP_SERVER_BINDING_DATA_VERSION &&
    typeof data.bindingId === "string" &&
    data.bindingId.trim()
      ? data.bindingId.trim()
      : data.version === 1 && typeof data.sessionFile === "string" && data.sessionFile.trim()
        ? legacyCodexConversationBindingId(data.sessionFile)
        : undefined;
  if (!bindingId) {
    return undefined;
  }
  const start = readConversationStart(readRecord(data.start));
  const source = readConversationSource(readRecord(data.source));
  const legacyBinding = data.version === 1;
  return {
    kind: "codex-app-server-session",
    version: APP_SERVER_BINDING_DATA_VERSION,
    bindingId,
    workspaceDir:
      typeof data.workspaceDir === "string" && data.workspaceDir.trim()
        ? data.workspaceDir
        : process.cwd(),
    agentId:
      typeof data.agentId === "string" && data.agentId.trim() ? data.agentId.trim() : undefined,
    agentDir:
      typeof data.agentDir === "string" && data.agentDir.trim() ? data.agentDir.trim() : undefined,
    ...(source ? { source } : {}),
    ...(start ? { start } : {}),
    ...(legacyBinding ? { legacyBinding: true } : {}),
  };
}

function readConversationSource(
  value: CodexAppServerConversationSource | Record<string, unknown> | undefined,
): CodexAppServerConversationSource | undefined {
  const agentId = readString(value, "agentId");
  const sessionId = readString(value, "sessionId");
  const threadId = readString(value, "threadId");
  const sessionKey = readString(value, "sessionKey");
  if (!agentId || !sessionId || !threadId) {
    return undefined;
  }
  return {
    agentId,
    sessionId,
    threadId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

/** Doctor/runtime v1 decoder key for shipped conversation bindings that stored a file locator. */
export function legacyCodexConversationBindingId(sessionFile: string): string {
  return `legacy-${createHash("sha256").update(sessionFile).digest("base64url")}`;
}

export function resolveCodexDefaultWorkspaceDir(pluginConfig: unknown): string {
  const appServer = readRecord(readRecord(pluginConfig)?.appServer);
  const configured = readString(appServer, "defaultWorkspaceDir");
  return configured ?? process.cwd();
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConversationStart(
  value: CodexAppServerConversationStart | Record<string, unknown> | undefined,
): CodexAppServerConversationStart | undefined {
  const read = (key: keyof CodexAppServerConversationStart) => {
    const candidate = value?.[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  };
  const start = {
    id: read("id"),
    threadId: read("threadId"),
    model: read("model"),
    modelProvider: read("modelProvider"),
    authProfileId: read("authProfileId"),
  };
  return start.id ? { ...start, id: start.id } : undefined;
}
