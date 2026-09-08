import { vi } from "vitest";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  resolvePersistentApplyInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));
const inferenceFallbackMocks = vi.hoisted(() => ({ verify: vi.fn() }));
const setupInferenceDetectionMocks = vi.hoisted(() => ({
  detectSetupInferenceIsolated: vi.fn(),
}));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn<
    (limit: number) => Array<{ role: "user" | "assistant"; text: string; at: number }>
  >(() => []),
}));
const greetingMocks = vi.hoisted(() => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({
  buildOnboardingWelcome: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback: inferenceFallbackMocks.verify,
}));
vi.mock("../../system-agent/setup-inference-detection.js", () => ({
  detectSetupInferenceIsolated: setupInferenceDetectionMocks.detectSetupInferenceIsolated,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: transcriptStoreMocks.appendTranscriptReset,
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));
vi.mock("../../system-agent/greeting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../system-agent/greeting.js")>();
  return {
    ...actual,
    acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
    loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
    resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
  };
});
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
}));

export {
  setupInferenceMocks,
  inferenceFallbackMocks,
  setupInferenceDetectionMocks,
  transcriptStoreMocks,
  greetingMocks,
  onboardingWelcomeMocks,
};
