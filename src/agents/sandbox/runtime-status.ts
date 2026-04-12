import { formatCliCommand } from "../../cli/command-format.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import {
  classifyToolAgainstSandboxToolPolicy,
  resolveSandboxToolPolicyForAgent,
} from "./tool-policy.js";
import type { SandboxConfig, SandboxToolPolicyResolved } from "./types.js";

function shouldSandboxSession(cfg: SandboxConfig, sessionKey: string, mainSessionKey: string) {
  if (cfg.mode === "off") {
    return false;
  }
  if (cfg.mode === "all") {
    return true;
  }
  return sessionKey.trim() !== mainSessionKey.trim();
}

function resolveMainSessionKeyForSandbox(params: {
  cfg?: OpenClawConfig;
  agentId: string;
}): string {
  if (params.cfg?.session?.scope === "global") {
    return "global";
  }
  return resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
  });
}

function resolveComparableSessionKeyForSandbox(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}

export function resolveSandboxRuntimeStatus(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
}): {
  agentId: string;
  sessionKey: string;
  mainSessionKey: string;
  mode: SandboxConfig["mode"];
  sandboxed: boolean;
  toolPolicy: SandboxToolPolicyResolved;
} {
  const sessionKey = params.sessionKey?.trim() ?? "";
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: params.cfg,
  });
  const cfg = params.cfg;
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  const mainSessionKey = resolveMainSessionKeyForSandbox({ cfg, agentId });
  const sandboxed = sessionKey
    ? shouldSandboxSession(
        sandboxCfg,
        resolveComparableSessionKeyForSandbox({ cfg, agentId, sessionKey }),
        mainSessionKey,
      )
    : false;
  return {
    agentId,
    sessionKey,
    mainSessionKey,
    mode: sandboxCfg.mode,
    sandboxed,
    toolPolicy: resolveSandboxToolPolicyForAgent(cfg, agentId),
  };
}

function sanitizeForSingleLineDisplay(value: string): string {
  return Array.from(value, (char) => {
    if (char === "\n") {
      return "\\n";
    }
    if (char === "\r") {
      return "\\r";
    }
    if (char === "\t") {
      return "\\t";
    }
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) {
      return `\\x${codePoint.toString(16).padStart(2, "0")}`;
    }
    return char;
  }).join("");
}

function hasUnsafeControlChars(value: string): boolean {
  return Array.from(value).some((char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function redactSessionKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(unknown)";
  }
  if (trimmed.length <= 12) {
    return "(redacted)";
  }
  return `${sanitizeForSingleLineDisplay(trimmed.slice(0, 6))}…${sanitizeForSingleLineDisplay(trimmed.slice(-6))}`;
}

function shellEscapeSingleArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatSandboxToolPolicyBlockedMessage(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  toolName: string;
}): string | undefined {
  const tool = normalizeOptionalLowercaseString(params.toolName);
  if (!tool) {
    return undefined;
  }

  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  if (!runtime.sandboxed) {
    return undefined;
  }

  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(
    tool,
    runtime.toolPolicy,
  );
  if (!blockedByDeny && !blockedByAllow) {
    return undefined;
  }

  const reasons: string[] = [];
  const fixes: string[] = [];
  if (blockedByDeny) {
    reasons.push("deny list");
    fixes.push(`Remove "${tool}" from ${runtime.toolPolicy.sources.deny.key}.`);
  }
  if (blockedByAllow) {
    reasons.push("allow list");
    fixes.push(
      `Add "${tool}" to ${runtime.toolPolicy.sources.allow.key} (or set it to [] to allow all).`,
    );
  }

  const lines: string[] = [];
  lines.push(`Tool "${tool}" blocked by sandbox tool policy (mode=${runtime.mode}).`);
  lines.push(`Session: ${redactSessionKey(runtime.sessionKey)}`);
  lines.push(`Reason: ${reasons.join(" + ")}`);
  lines.push("Fix:");
  lines.push(`- agents.defaults.sandbox.mode=off (disable sandbox)`);
  for (const fix of fixes) {
    lines.push(`- ${fix}`);
  }
  if (runtime.mode === "non-main") {
    lines.push("- Use the agent main session instead of a non-main session.");
  }
  const explainCommand = runtime.sessionKey
    ? hasUnsafeControlChars(runtime.sessionKey)
      ? `openclaw sandbox explain --agent ${runtime.agentId}`
      : `openclaw sandbox explain --session ${shellEscapeSingleArg(runtime.sessionKey)}`
    : "openclaw sandbox explain";
  lines.push(`- See: ${formatCliCommand(explainCommand)}`);

  return lines.join("\n");
}
