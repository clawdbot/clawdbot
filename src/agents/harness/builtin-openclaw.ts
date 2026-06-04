/**
 * Built-in OpenClaw harness registration.
 *
 * Harness selection uses this factory to expose the embedded OpenClaw runtime
 * through the same AgentHarness contract as external harness plugins.
 */
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { runEmbeddedAttempt } from "../embedded-agent-runner/run/attempt.js";
import type { AgentHarness } from "./types.js";

/** Creates the built-in harness backed by the embedded OpenClaw agent runner. */
export function createOpenClawAgentHarness(): AgentHarness {
  return {
    id: "openclaw",
    label: "OpenClaw embedded agent",
    contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
  };
}
