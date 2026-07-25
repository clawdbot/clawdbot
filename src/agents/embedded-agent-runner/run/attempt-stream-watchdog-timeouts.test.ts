// Pins the reported #113092 scenario end to end: a self-hosted provider on
// loopback whose `models.providers.<id>.timeoutSeconds` reaches both stream
// watchdogs as `requestTimeoutMs`. Lives beside the resolver tests rather than
// inside them because `llm-idle-timeout.test.ts` is at its max-lines ceiling.
import { describe, expect, it } from "vitest";
import { resolveLlmFirstEventTimeoutMs, resolveLlmIdleTimeoutMs } from "./llm-idle-timeout.js";

// Matches the reported llama.cpp setup: loopback base URL, self-hosted provider.
const reportedModel = {
  baseUrl: "http://127.0.0.1:8080/v1",
  id: "ornith-1.0-35b",
  provider: "llama-cpp",
};

const PROVIDER_TIMEOUT_MS = 3_600_000;

describe("provider request timeout reaches both stream watchdogs", () => {
  it("raises both watchdogs to the provider request timeout", () => {
    const params = { modelRequestTimeoutMs: PROVIDER_TIMEOUT_MS, model: reportedModel };
    expect(resolveLlmIdleTimeoutMs(params)).toBe(PROVIDER_TIMEOUT_MS);
    expect(resolveLlmFirstEventTimeoutMs(params)).toBe(PROVIDER_TIMEOUT_MS);
  });

  it("falls back to the 300s first-event guard without a provider request timeout", () => {
    // Loopback opts out of gap policing entirely (idle 0), so the first-event
    // guard is what aborts long local prompt evaluation. This is the abort the
    // report observed at ~300s.
    expect(resolveLlmIdleTimeoutMs({ model: reportedModel })).toBe(0);
    expect(resolveLlmFirstEventTimeoutMs({ model: reportedModel })).toBe(300_000);
  });

  it("keeps an explicit shorter run budget above the provider request timeout", () => {
    const params = {
      runTimeoutMs: 45_000,
      modelRequestTimeoutMs: PROVIDER_TIMEOUT_MS,
      model: reportedModel,
    };
    expect(resolveLlmIdleTimeoutMs(params)).toBe(45_000);
    expect(resolveLlmFirstEventTimeoutMs(params)).toBe(45_000);
  });
});
