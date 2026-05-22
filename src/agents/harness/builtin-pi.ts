import { PI_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { runEmbeddedAttempt } from "../pi-embedded-runner/run/attempt.js";
import type { AgentHarness } from "./types.js";

export function createPiAgentHarness(): AgentHarness {
  return {
    id: "pi",
    label: "PI embedded agent",
    contextEngineHostCapabilities: PI_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: runEmbeddedAttempt,
  };
}
