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
  OPENCLAW_AGENT_RUNTIME_ID,
} from "../agents/agent-runtime-id.js";
import { isCliProvider, type CliProviderClassifier } from "../agents/model-selection.js";
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

type AgentRuntimeLabelArgs = {
  config?: OpenClawConfig;
  sessionEntry?: Pick<
    SessionEntry,
    | "acp"
    | "agentRuntimeOverride"
    | "agentHarnessId"
    | "modelProvider"
    | "modelSelectionLocked"
    | "providerOverride"
  >;
  resolvedHarness?: string;
  fallbackProvider?: string;
  classifyCliProvider?: CliProviderClassifier;
};

/** The runtime the label describes, kept beside its text so the pin can be compared to it. */
function resolveDescribedAgentRuntime(args: AgentRuntimeLabelArgs): {
  label: string;
  runtime?: string;
} {
  const runtimeRaw = normalizeOptionalString(args.resolvedHarness);
  const runtime = normalizeOptionalLowercaseString(runtimeRaw);
  if (runtime && runtime !== "auto" && runtime !== "default") {
    return {
      label: AGENT_RUNTIME_LABELS[runtime] ?? sanitizeTerminalText(runtimeRaw ?? runtime),
      runtime,
    };
  }

  const providerRaw =
    normalizeOptionalString(args.sessionEntry?.modelProvider) ??
    normalizeOptionalString(args.sessionEntry?.providerOverride) ??
    normalizeOptionalString(args.fallbackProvider);
  const provider = providerRaw ? sanitizeTerminalText(providerRaw) : undefined;
  const providerRuntime = normalizeOptionalLowercaseString(providerRaw);
  if (provider && (args.classifyCliProvider?.(provider) ?? isCliProvider(provider, args.config))) {
    return {
      label: AGENT_RUNTIME_LABELS[providerRuntime ?? ""] ?? `${provider} (cli)`,
      runtime: providerRuntime,
    };
  }

  return {
    label: expectDefined(AGENT_RUNTIME_LABELS.openclaw, "OpenClaw runtime label"),
    runtime: OPENCLAW_AGENT_RUNTIME_ID,
  };
}

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

  const described = resolveDescribedAgentRuntime(args);
  const recordedRuntime = normalizeOptionalAgentRuntimeId(args.sessionEntry?.agentHarnessId);
  // `agentHarnessId` always identifies the runtime that produced the transcript,
  // but only a model-selection-locked session treats it as an active routing pin.
  // Keep those meanings visibly distinct so ordinary history cannot be mistaken
  // for the runtime that owns the next turn.
  if (
    !recordedRuntime ||
    isDefaultAgentRuntimeId(recordedRuntime) ||
    recordedRuntime === normalizeOptionalAgentRuntimeId(described.runtime)
  ) {
    return described.label;
  }
  const relationship =
    args.sessionEntry?.modelSelectionLocked === true ? "session pin" : "previous runtime";
  return `${described.label} (${relationship}: ${
    AGENT_RUNTIME_LABELS[recordedRuntime] ?? sanitizeTerminalText(recordedRuntime)
  })`;
}
