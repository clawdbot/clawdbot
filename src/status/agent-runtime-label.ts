import { expectDefined } from "@openclaw/normalization-core";
// Agent runtime label helpers format provider, model, and runtime labels.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import {
  isDefaultAgentRuntimeId,
  normalizeOptionalAgentRuntimeId,
} from "../agents/agent-runtime-id.js";
import { isCliProvider, type CliProviderClassifier } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";

// Status runtime labels turn harness/provider/session state into a short
// operator-facing name, sanitizing any persisted ACP/backend text.
const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  openclaw: "OpenClaw Default",
  codex: "OpenAI Codex",
  "codex-cli": "OpenAI Codex",
  "claude-cli": "Claude CLI",
  "google-gemini-cli": "Gemini CLI",
};

type AgentRuntimeLabelArgs = {
  config?: OpenClawConfig;
  sessionEntry?: Pick<
    SessionEntry,
    | "acp"
    | "agentRuntimeOverride"
    | "agentHarnessId"
    | "modelProvider"
    | "modelSelectionLocked"
    | "pluginOwnerId"
    | "providerOverride"
  >;
  resolvedHarness?: string;
  fallbackProvider?: string;
  classifyCliProvider?: CliProviderClassifier;
};

export function resolveAgentRuntimeLabel(args: AgentRuntimeLabelArgs): string {
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
  let label: string;
  if (runtime && runtime !== "auto" && runtime !== "default") {
    label = AGENT_RUNTIME_LABELS[runtime] ?? sanitizeTerminalText(runtimeRaw ?? runtime);
  } else {
    const providerRaw =
      normalizeOptionalString(args.sessionEntry?.modelProvider) ??
      normalizeOptionalString(args.sessionEntry?.providerOverride) ??
      normalizeOptionalString(args.fallbackProvider);
    const provider = providerRaw ? sanitizeTerminalText(providerRaw) : undefined;
    const providerRuntime = normalizeOptionalLowercaseString(providerRaw);
    if (
      provider &&
      (args.classifyCliProvider?.(provider) ?? isCliProvider(provider, args.config))
    ) {
      label = AGENT_RUNTIME_LABELS[providerRuntime ?? ""] ?? `${provider} (cli)`;
    } else {
      label = expectDefined(AGENT_RUNTIME_LABELS.openclaw, "OpenClaw runtime label");
    }
  }

  const recordedRuntime = normalizeOptionalAgentRuntimeId(args.sessionEntry?.agentHarnessId);
  // Unlocked harness ids describe transcript history; locked ids describe an active pin.
  const recordedLabel = recordedRuntime
    ? (AGENT_RUNTIME_LABELS[recordedRuntime] ?? sanitizeTerminalText(recordedRuntime))
    : undefined;
  if (!recordedRuntime || isDefaultAgentRuntimeId(recordedRuntime) || recordedLabel === label) {
    return label;
  }
  const relationship = resolveSessionPinnedHarnessId(args.sessionEntry)
    ? "session pin"
    : "previous runtime";
  return `${label} (${relationship}: ${recordedLabel})`;
}
