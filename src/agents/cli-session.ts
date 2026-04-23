import crypto from "node:crypto";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeProviderId } from "./model-selection.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

export function getCliSessionBinding(
  entry: SessionEntry | undefined,
  provider: string,
): CliSessionBinding | undefined {
  if (!entry) {
    return undefined;
  }
  const normalized = normalizeProviderId(provider);
  const fromBindings = entry.cliSessionBindings?.[normalized];
  const bindingSessionId = normalizeOptionalString(fromBindings?.sessionId);
  if (bindingSessionId) {
    return {
      sessionId: bindingSessionId,
      authProfileId: normalizeOptionalString(fromBindings?.authProfileId),
      authEpoch: normalizeOptionalString(fromBindings?.authEpoch),
      authEpochVersion: fromBindings?.authEpochVersion,
      extraSystemPromptHash: normalizeOptionalString(fromBindings?.extraSystemPromptHash),
      mcpConfigHash: normalizeOptionalString(fromBindings?.mcpConfigHash),
      mcpResumeHash: normalizeOptionalString(fromBindings?.mcpResumeHash),
    };
  }
  const fromMap = entry.cliSessionIds?.[normalized];
  const normalizedFromMap = normalizeOptionalString(fromMap);
  if (normalizedFromMap) {
    return { sessionId: normalizedFromMap };
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    const legacy = normalizeOptionalString(entry.claudeCliSessionId);
    if (legacy) {
      return { sessionId: legacy };
    }
  }
  return undefined;
}

export function getCliSessionId(
  entry: SessionEntry | undefined,
  provider: string,
): string | undefined {
  return getCliSessionBinding(entry, provider)?.sessionId;
}

export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

export function setCliSessionBinding(
  entry: SessionEntry,
  provider: string,
  binding: CliSessionBinding,
): void {
  const normalized = normalizeProviderId(provider);
  const trimmed = binding.sessionId.trim();
  if (!trimmed) {
    return;
  }
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(normalizeOptionalString(binding.authProfileId)
        ? { authProfileId: normalizeOptionalString(binding.authProfileId) }
        : {}),
      ...(normalizeOptionalString(binding.authEpoch)
        ? { authEpoch: normalizeOptionalString(binding.authEpoch) }
        : {}),
      ...(typeof binding.authEpochVersion === "number" && Number.isFinite(binding.authEpochVersion)
        ? { authEpochVersion: binding.authEpochVersion }
        : {}),
      ...(normalizeOptionalString(binding.extraSystemPromptHash)
        ? { extraSystemPromptHash: normalizeOptionalString(binding.extraSystemPromptHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpResumeHash)
        ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) }
        : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

export function clearCliSession(entry: SessionEntry, provider: string): void {
  const normalized = normalizeProviderId(provider);
  if (entry.cliSessionBindings?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionBindings };
    delete next[normalized];
    entry.cliSessionBindings = Object.keys(next).length > 0 ? next : undefined;
  }
  if (entry.cliSessionIds?.[normalized] !== undefined) {
    const next = { ...entry.cliSessionIds };
    delete next[normalized];
    entry.cliSessionIds = Object.keys(next).length > 0 ? next : undefined;
  }
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = undefined;
  }
}

export function clearAllCliSessions(entry: SessionEntry): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}

export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
}): {
  sessionId?: string;
  invalidatedReason?: "auth-profile" | "auth-epoch" | "system-prompt" | "mcp";
} {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return {};
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  if (storedAuthProfileId !== currentAuthProfileId) {
    return { invalidatedReason: "auth-profile" };
  }
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  if (
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch
  ) {
    return { invalidatedReason: "auth-epoch" };
  }
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    return { invalidatedReason: "system-prompt" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { invalidatedReason: "mcp" };
    }
    return { sessionId };
  }
  const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
  if (storedMcpConfigHash !== currentMcpConfigHash) {
    return { invalidatedReason: "mcp" };
  }
  return { sessionId };
}
