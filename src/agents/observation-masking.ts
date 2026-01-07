import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import type { ClawdbotConfig } from "../config/config.js";

const DEFAULT_KEEP_LAST = 1;
const DEFAULT_PLACEHOLDER = "Previous observation omitted for brevity.";

export type ObservationMaskingOptions = {
  keepLast: number;
  placeholder: string;
};

export function resolveObservationMaskingOptions(
  cfg?: ClawdbotConfig,
): ObservationMaskingOptions | null {
  const raw = cfg?.agent?.observationMasking;
  if (!raw?.enabled) return null;
  const keepLast =
    typeof raw.keepLast === "number" && Number.isFinite(raw.keepLast)
      ? Math.max(0, Math.floor(raw.keepLast))
      : DEFAULT_KEEP_LAST;
  const placeholder = raw.placeholder?.trim() || DEFAULT_PLACEHOLDER;
  return { keepLast, placeholder };
}

function isToolResultMessage(
  message: AgentMessage,
): message is AgentMessage & { role: "toolResult" } {
  return Boolean(
    message &&
      typeof message === "object" &&
      "role" in message &&
      (message as { role?: unknown }).role === "toolResult",
  );
}

export function maskToolResultsForContext(
  messages: AgentMessage[],
  options: ObservationMaskingOptions,
): AgentMessage[] {
  const keepLast = Math.max(0, Math.floor(options.keepLast));
  let totalToolResults = 0;
  for (const message of messages) {
    if (message && isToolResultMessage(message)) totalToolResults += 1;
  }
  if (totalToolResults <= keepLast) return messages;

  // Observation masking is applied only at context time so session history keeps full tool outputs.
  const masked = messages.slice();
  let remaining = keepLast;
  for (let i = masked.length - 1; i >= 0; i -= 1) {
    const message = masked[i];
    if (!message || !isToolResultMessage(message)) continue;
    if (remaining > 0) {
      remaining -= 1;
      continue;
    }
    masked[i] = {
      ...(message as object),
      content: [{ type: "text", text: options.placeholder }],
    } as AgentMessage;
  }
  return masked;
}

export function createObservationMaskingExtension(
  options: ObservationMaskingOptions,
): ExtensionFactory {
  return (pi) => {
    pi.on("context", (event) => {
      const masked = maskToolResultsForContext(event.messages, options);
      return { messages: masked };
    });
  };
}
