/**
 * Resolves trigger-specific prompt injection behavior.
 */
import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY: EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: false,
};

const EMBEDDED_RUN_TRIGGER_POLICY: Partial<Record<EmbeddedRunTrigger, EmbeddedRunTriggerPolicy>> = {
  // Heartbeat runs are scheduler-originated and need an explicit prompt nudge;
  // all user/operator triggers keep their existing prompt shape by default.
  heartbeat: {
    injectHeartbeatPrompt: true,
  },
};

/**
 * Decides whether a run trigger should add the heartbeat-specific prompt
 * instruction. Unknown or omitted triggers fall back to the user-prompt shape
 * so non-heartbeat runs do not get scheduler wording.
 */
export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}
