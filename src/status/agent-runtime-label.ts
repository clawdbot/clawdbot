import { isCliProvider } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { sanitizeTerminalText } from "../terminal/safe-text.js";

const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  pi: "OpenClaw Pi Default",
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

  return AGENT_RUNTIME_LABELS.pi;
}
