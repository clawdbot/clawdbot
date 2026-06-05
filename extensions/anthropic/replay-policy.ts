/**
 * Anthropic replay-policy bridge. It re-exports the native Anthropic replay
 * policy from the shared provider-model hooks and fails fast if it disappears.
 */
import { NATIVE_ANTHROPIC_REPLAY_HOOKS } from "openclaw/plugin-sdk/provider-model-shared";

const { buildReplayPolicy } = NATIVE_ANTHROPIC_REPLAY_HOOKS;

if (!buildReplayPolicy) {
  throw new Error("Expected native Anthropic replay hooks to expose buildReplayPolicy.");
}

export { buildReplayPolicy as buildAnthropicReplayPolicy };
