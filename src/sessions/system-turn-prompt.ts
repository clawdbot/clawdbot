// Canonical prefix for model-facing internal system turns (restart recovery,
// stranded-reply retry, subagent resume). Lives outside input-provenance so the
// helper stays core-internal instead of widening the plugin SDK API surface.
const SYSTEM_TURN_PROMPT_PREFIX = "[System]";

export function formatSystemTurnPrompt(body: string): string {
  const trimmedBody = body.trim();
  return trimmedBody.startsWith(SYSTEM_TURN_PROMPT_PREFIX)
    ? trimmedBody
    : `${SYSTEM_TURN_PROMPT_PREFIX} ${trimmedBody}`;
}
