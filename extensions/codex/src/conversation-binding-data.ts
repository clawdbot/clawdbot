import process from "node:process";
import type { PluginConversationBinding } from "openclaw/plugin-sdk/plugin-entry";

const BINDING_DATA_VERSION = 1;

export type CodexConversationBindingData = {
  kind: "codex-app-server-session";
  version: 1;
  sessionFile: string;
  workspaceDir: string;
};

export function createCodexConversationBindingData(params: {
  sessionFile: string;
  workspaceDir: string;
}): CodexConversationBindingData {
  return {
    kind: "codex-app-server-session",
    version: BINDING_DATA_VERSION,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
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
  if (
    data.kind !== "codex-app-server-session" ||
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
