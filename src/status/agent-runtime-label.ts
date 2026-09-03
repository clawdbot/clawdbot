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

/** Renders one runtime id with the operator-facing vocabulary, sanitizing unknown ids. */
function formatAgentRuntimeLabel(runtime: string): string {
  return AGENT_RUNTIME_LABELS[runtime] ?? sanitizeTerminalText(runtime);
}

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
  // Retired runtime ids stay in old session entries forever: an upgraded session
  // still persists `agentHarnessId: "codex-cli"` while the live runtime resolves to
  // `codex`, and AGENT_RUNTIME_LABELS deliberately renders both as "OpenAI Codex".
  // Comparing raw ids there reports `OpenAI Codex (previous runtime: OpenAI Codex)`
  // — a runtime transition that never happened. Two ids the operator sees under one
  // name are one runtime for this annotation's purpose, so compare what is rendered.
  const recordedLabel = recordedRuntime ? formatAgentRuntimeLabel(recordedRuntime) : undefined;
  if (
    !recordedRuntime ||
    isDefaultAgentRuntimeId(recordedRuntime) ||
    recordedRuntime === normalizeOptionalAgentRuntimeId(described.runtime) ||
    recordedLabel === described.label
  ) {
    return described.label;
  }
  const relationship =
    args.sessionEntry?.modelSelectionLocked === true ? "session pin" : "previous runtime";
  return `${described.label} (${relationship}: ${recordedLabel})`;
}
