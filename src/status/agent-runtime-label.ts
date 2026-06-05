// Agent runtime label helpers format provider, model, and runtime labels.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { isCliProvider } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

// Status runtime labels turn harness/provider/session state into a short
// operator-facing name, sanitizing any persisted ACP/backend text.
const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  openclaw: "OpenClaw Default",
  codex: "OpenAI Codex",
  "codex-cli": "OpenAI Codex",
  "claude-cli": "Claude CLI",
  "google-gemini-cli": "Gemini CLI",
};

export function resolveAgentRuntimeLabel(args: {
  config?: OpenClawConfig;
  sessionEntry?: Pick<
    SessionEntry,
    "acp" | "agentRuntimeOverride" | "agentHarnessId" | "modelProvider" | "providerOverride"
  >;
  resolvedHarness?: string;
  fallbackProvider?: string;
}): string {
  const acpAgentRaw = normalizeOptionalString(args.sessionEntry?.acp?.agent);
  const acpAgent = acpAgentRaw ? sanitizeTerminalText(acpAgentRaw) : undefined;
  // ACP sessions own their displayed runtime because the backend can differ
  // from the normal model/provider selection path.
  if (acpAgent) {
    const backendRaw = normalizeOptionalString(args.sessionEntry?.acp?.backend);
    const backend = backendRaw ? sanitizeTerminalText(backendRaw) : undefined;
    return backend ? `${acpAgent} (acp/${backend})` : `${acpAgent} (acp)`;
  }

  const runtimeRaw = normalizeOptionalString(args.resolvedHarness);
  const runtime = normalizeOptionalLowercaseString(runtimeRaw);
  if (runtime && runtime !== "auto" && runtime !== "default") {
    return AGENT_RUNTIME_LABELS[runtime] ?? sanitizeTerminalText(runtimeRaw ?? runtime);
  }

  const providerRaw =
    normalizeOptionalString(args.sessionEntry?.modelProvider) ??
    normalizeOptionalString(args.sessionEntry?.providerOverride) ??
    normalizeOptionalString(args.fallbackProvider);
  const provider = providerRaw ? sanitizeTerminalText(providerRaw) : undefined;
  if (provider && isCliProvider(provider, args.config)) {
    return (
      AGENT_RUNTIME_LABELS[normalizeOptionalLowercaseString(providerRaw) ?? ""] ??
      `${provider} (cli)`
    );
  }

  return AGENT_RUNTIME_LABELS.openclaw;
}
