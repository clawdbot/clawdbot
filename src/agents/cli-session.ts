/**
 * CLI session persistence helpers.
 * Keeps provider-keyed session bindings, reuse fingerprints, and legacy
 * Claude CLI state in one normalized session-store contract.
 */
import crypto from "node:crypto";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { CliSessionBinding, SessionEntry } from "../config/sessions.js";
import { normalizeCliSessionReseedReceipt } from "../config/sessions/cli-session-binding.js";
export { getCliSessionBinding, getCliSessionId } from "../config/sessions/cli-session-binding.js";

const CLAUDE_CLI_BACKEND_ID = "claude-cli";

/** Hash CLI session-sensitive text so reuse checks can compare stable fingerprints. */
export function hashCliSessionText(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return crypto.createHash("sha256").update(trimmed).digest("hex");
}

/** Store a reusable CLI session ID without extra reuse guards. */
export function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void {
  setCliSessionBinding(entry, provider, { sessionId });
}

/** Store a CLI session binding and mirror it to legacy/simple session-id fields. */
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
  const previousBinding = entry.cliSessionBindings?.[normalized];
  const previousReceipt =
    normalizeOptionalString(previousBinding?.sessionId) === trimmed
      ? normalizeCliSessionReseedReceipt(previousBinding?.reseedReceipt)
      : undefined;
  const reseedReceipt = normalizeCliSessionReseedReceipt(binding.reseedReceipt) ?? previousReceipt;
  entry.cliSessionBindings = {
    ...entry.cliSessionBindings,
    [normalized]: {
      sessionId: trimmed,
      ...(binding.forceReuse === true ? { forceReuse: true } : {}),
      ...(binding.forkNextResume === true ? { forkNextResume: true } : {}),
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
      ...(normalizeOptionalString(binding.messageToolPolicyHash)
        ? { messageToolPolicyHash: normalizeOptionalString(binding.messageToolPolicyHash) }
        : {}),
      ...(normalizeOptionalString(binding.promptToolNamesHash)
        ? { promptToolNamesHash: normalizeOptionalString(binding.promptToolNamesHash) }
        : {}),
      ...(normalizeOptionalString(binding.cwdHash)
        ? { cwdHash: normalizeOptionalString(binding.cwdHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpConfigHash)
        ? { mcpConfigHash: normalizeOptionalString(binding.mcpConfigHash) }
        : {}),
      ...(normalizeOptionalString(binding.mcpResumeHash)
        ? { mcpResumeHash: normalizeOptionalString(binding.mcpResumeHash) }
        : {}),
      ...(reseedReceipt ? { reseedReceipt } : {}),
    },
  };
  entry.cliSessionIds = { ...entry.cliSessionIds, [normalized]: trimmed };
  if (normalized === CLAUDE_CLI_BACKEND_ID) {
    entry.claudeCliSessionId = trimmed;
  }
}

/** Remove the stored CLI session binding for one provider. */
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

type MutableCliSessionFields = Pick<
  SessionEntry,
  "cliSessionBindings" | "cliSessionIds" | "claudeCliSessionId"
>;

/** Remove every CLI session binding from a session entry. */
export function clearAllCliSessions(entry: Partial<MutableCliSessionFields>): void {
  entry.cliSessionBindings = undefined;
  entry.cliSessionIds = undefined;
  entry.claudeCliSessionId = undefined;
}

type CliSessionInvalidatedReason = "auth-profile" | "auth-epoch" | "message-policy" | "cwd" | "mcp";

type CliSessionContentDriftReason = "system-prompt" | "prompt-tools";

export type CliSessionReuseResult =
  | { mode: "none" }
  | { mode: "reuse"; sessionId: string }
  | {
      mode: "reuse-with-drift";
      sessionId: string;
      drift: { reasons: CliSessionContentDriftReason[] };
    }
  | { mode: "invalidate"; invalidatedReason: CliSessionInvalidatedReason };

/** Decide whether a stored CLI session can be reused for the current auth/prompt/cwd/MCP state. */
export function resolveCliSessionReuse(params: {
  binding?: CliSessionBinding;
  authProfileId?: string;
  authEpoch?: string;
  authEpochVersion: number;
  extraSystemPromptHash?: string;
  messageToolPolicyHash?: string;
  promptToolNamesHash?: string;
  cwdHash?: string;
  mcpConfigHash?: string;
  mcpResumeHash?: string;
}): CliSessionReuseResult {
  const binding = params.binding;
  const sessionId = normalizeOptionalString(binding?.sessionId);
  if (!sessionId) {
    return { mode: "none" };
  }
  if (binding?.forceReuse === true) {
    return { mode: "reuse", sessionId };
  }
  const currentAuthProfileId = normalizeOptionalString(params.authProfileId);
  const currentAuthEpoch = normalizeOptionalString(params.authEpoch);
  const currentExtraSystemPromptHash = normalizeOptionalString(params.extraSystemPromptHash);
  const currentMessageToolPolicyHash = normalizeOptionalString(params.messageToolPolicyHash);
  const currentPromptToolNamesHash = normalizeOptionalString(params.promptToolNamesHash);
  const currentCwdHash = normalizeOptionalString(params.cwdHash);
  const currentMcpConfigHash = normalizeOptionalString(params.mcpConfigHash);
  const currentMcpResumeHash = normalizeOptionalString(params.mcpResumeHash);
  const storedAuthProfileId = normalizeOptionalString(binding?.authProfileId);
  const storedAuthEpoch = normalizeOptionalString(binding?.authEpoch);
  const hasMatchingVersionedAuthEpoch =
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== undefined &&
    currentAuthEpoch !== undefined &&
    storedAuthEpoch === currentAuthEpoch;
  if (storedAuthProfileId !== currentAuthProfileId) {
    if (!hasMatchingVersionedAuthEpoch) {
      return { mode: "invalidate", invalidatedReason: "auth-profile" };
    }
  }
  if (
    binding?.authEpochVersion === params.authEpochVersion &&
    storedAuthEpoch !== currentAuthEpoch
  ) {
    return { mode: "invalidate", invalidatedReason: "auth-epoch" };
  }
  const storedMessageToolPolicyHash = normalizeOptionalString(binding?.messageToolPolicyHash);
  if (storedMessageToolPolicyHash !== currentMessageToolPolicyHash) {
    return { mode: "invalidate", invalidatedReason: "message-policy" };
  }
  const storedCwdHash = normalizeOptionalString(binding?.cwdHash);
  if (storedCwdHash !== undefined && storedCwdHash !== currentCwdHash) {
    return { mode: "invalidate", invalidatedReason: "cwd" };
  }
  const storedMcpResumeHash = normalizeOptionalString(binding?.mcpResumeHash);
  if (storedMcpResumeHash && currentMcpResumeHash) {
    // Resume hashes are stricter than raw MCP config hashes: a match proves the
    // exact resumed CLI tool topology still belongs to this session.
    if (storedMcpResumeHash !== currentMcpResumeHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  } else {
    const storedMcpConfigHash = normalizeOptionalString(binding?.mcpConfigHash);
    if (storedMcpConfigHash !== currentMcpConfigHash) {
      return { mode: "invalidate", invalidatedReason: "mcp" };
    }
  }

  const driftReasons: CliSessionContentDriftReason[] = [];
  const storedExtraSystemPromptHash = normalizeOptionalString(binding?.extraSystemPromptHash);
  if (storedExtraSystemPromptHash !== currentExtraSystemPromptHash) {
    driftReasons.push("system-prompt");
  }
  const storedPromptToolNamesHash = normalizeOptionalString(binding?.promptToolNamesHash);
  if (storedPromptToolNamesHash !== currentPromptToolNamesHash) {
    driftReasons.push("prompt-tools");
  }
  if (driftReasons.length > 0) {
    // Content drift resumes by contract (#99729): the transcript remains usable.
    // Deleting this binding here makes queued turns spawn without session history.
    return { mode: "reuse-with-drift", sessionId, drift: { reasons: driftReasons } };
  }
  return { mode: "reuse", sessionId };
}
