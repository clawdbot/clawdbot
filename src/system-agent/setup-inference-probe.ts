const SETUP_INFERENCE_TEST_MAX_TOKENS = 32;

/** Plugin and auto-selected harnesses may not support OpenClaw's request-scoped token cap. */
export function resolveSetupInferenceProbeStreamParams(agentHarnessId?: string): {
  streamParams?: { maxTokens: number };
} {
  return !agentHarnessId || agentHarnessId === "openclaw"
    ? { streamParams: { maxTokens: SETUP_INFERENCE_TEST_MAX_TOKENS } }
    : {};
}
