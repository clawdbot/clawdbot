/** Extracts user-visible assistant text from an agent-command result. */
export function extractAgentCommandReply(result: unknown): string | undefined {
  const candidate = result as { meta?: { error?: unknown }; payloads?: unknown } | null | undefined;
  const error =
    candidate?.meta?.error &&
    typeof candidate.meta.error === "object" &&
    !Array.isArray(candidate.meta.error)
      ? (candidate.meta.error as { kind?: unknown; terminalPresentation?: unknown })
      : undefined;
  if (error?.kind === "incomplete_turn" && error.terminalPresentation !== true) {
    return undefined;
  }
  const payloads = candidate?.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  const texts = payloads
    .map((payload) =>
      payload &&
      typeof payload === "object" &&
      typeof (payload as { text?: unknown }).text === "string"
        ? (payload as { text: string }).text
        : "",
    )
    .filter((text) => text.trim().length > 0);
  return texts.length > 0 ? texts.join("\n\n") : undefined;
}
