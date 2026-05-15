import process from "node:process";
import type { PluginConversationBinding } from "openclaw/plugin-sdk/plugin-entry";

const BINDING_DATA_VERSION = 1;

export type CodexAppServerConversationBindingData = {
  kind: "codex-app-server-session";
  version: 1;
  sessionFile: string;
  workspaceDir: string;
};

export type CodexCliNodeConversationBindingData = {
  kind: "codex-cli-node-session";
  version: 1;
  nodeId: string;
  sessionId: string;
  cwd?: string;
};

export type CodexConversationBindingData =
  | CodexAppServerConversationBindingData
  | CodexCliNodeConversationBindingData;

export function createCodexConversationBindingData(params: {
  sessionFile: string;
  workspaceDir: string;
}): CodexAppServerConversationBindingData {
  return {
    kind: "codex-app-server-session",
    version: BINDING_DATA_VERSION,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
  };
}

export function createCodexCliNodeConversationBindingData(params: {
  nodeId: string;
  sessionId: string;
  cwd?: string;
}): CodexCliNodeConversationBindingData {
  const cwd = params.cwd?.trim();
  return {
    kind: "codex-cli-node-session",
    version: BINDING_DATA_VERSION,
    nodeId: params.nodeId,
    sessionId: params.sessionId,
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
      data.version !== BINDING_DATA_VERSION ||
      typeof data.nodeId !== "string" ||
      !data.nodeId.trim() ||
      typeof data.sessionId !== "string" ||
      !data.sessionId.trim()
    ) {
      return undefined;
    }
    return {
      kind: "codex-cli-node-session",
      version: BINDING_DATA_VERSION,
      nodeId: data.nodeId.trim(),
      sessionId: data.sessionId.trim(),
      cwd: typeof data.cwd === "string" && data.cwd.trim() ? data.cwd.trim() : undefined,
    };
  }
  if (data.kind !== "codex-app-server-session") {
    return undefined;
  }
  if (
    data.version !== BINDING_DATA_VERSION ||
    typeof data.sessionFile !== "string" ||
    !data.sessionFile.trim()
  ) {
    return undefined;
  }
  return {
    kind: "codex-app-server-session",
    version: BINDING_DATA_VERSION,
    sessionFile: data.sessionFile,
    workspaceDir:
      typeof data.workspaceDir === "string" && data.workspaceDir.trim()
        ? data.workspaceDir
        : process.cwd(),
  };
}

export function resolveCodexDefaultWorkspaceDir(pluginConfig: unknown): string {
  const appServer = readRecord(readRecord(pluginConfig)?.appServer);
  const configured = readString(appServer, "defaultWorkspaceDir");
  return configured ?? process.cwd();
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
