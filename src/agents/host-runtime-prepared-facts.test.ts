import { describe, expect, it } from "vitest";
import {
  resolveHostRuntimeProviderAuthPolicy,
  resolveHostRuntimeToolPolicy,
} from "./host-runtime-prepared-facts.js";

function createPreparedFact(params: {
  endpointId?: string;
  modelRef?: string;
  credentialRef?: string;
  eligibility?: "ok" | "expired" | "missing" | "unresolved";
}) {
  const endpointId = params.endpointId ?? "telegram:geeclaw";
  return {
    [endpointId]: {
      kind: "host-runtime-prepared-facts",
      version: 1,
      hostMode: "external-hosted",
      envelope: {
        provider: {
          modelRef: params.modelRef ?? "custom-openai/test-model",
          routingPolicyId: "gee-routing-main",
          fallbackPolicyId: "gee-fallback-main",
          cooldownPolicyId: "gee-cooldown-main",
        },
        auth: {
          credentialRef: params.credentialRef ?? "gee-credential-main",
          eligibility: params.eligibility ?? "ok",
        },
        tools: {
          capabilityPlanId: "gee-capability-main",
          allowedToolIds: ["video_generate"],
          policy: "host-authorized",
        },
      },
    },
  };
}

describe("resolveHostRuntimeProviderAuthPolicy", () => {
  it("extracts Host-owned provider, auth, fallback, and cooldown facts", () => {
    expect(resolveHostRuntimeProviderAuthPolicy(createPreparedFact({}))).toEqual({
      endpointIds: ["telegram:geeclaw"],
      modelRefs: ["custom-openai/test-model"],
      routingPolicyIds: ["gee-routing-main"],
      fallbackPolicyIds: ["gee-fallback-main"],
      cooldownPolicyIds: ["gee-cooldown-main"],
      credentialRefs: ["gee-credential-main"],
      authEligibility: "ok",
    });
  });

  it("fails closed when a Externally hosted auth fact is missing", () => {
    const preparedFacts = createPreparedFact({});
    delete (preparedFacts["telegram:geeclaw"].envelope.auth as { credentialRef?: string })
      .credentialRef;

    expect(() => resolveHostRuntimeProviderAuthPolicy(preparedFacts)).toThrow(
      'Externally hosted OpenClaw endpoint "telegram:geeclaw" has invalid prepared runtime fact "envelope.auth.credentialRef".',
    );
  });

  it("rejects conflicting auth eligibility across Externally hosted endpoints", () => {
    expect(() =>
      resolveHostRuntimeProviderAuthPolicy({
        ...createPreparedFact({ endpointId: "telegram:geeclaw", eligibility: "ok" }),
        ...createPreparedFact({ endpointId: "slack:geeclaw", eligibility: "expired" }),
      }),
    ).toThrow(/conflicting auth eligibility states/);
  });
});

describe("resolveHostRuntimeToolPolicy", () => {
  it("extracts tool policy for exactly one active endpoint", () => {
    expect(resolveHostRuntimeToolPolicy(createPreparedFact({}))).toEqual({
      allowedToolIds: ["video_generate"],
      endpointIds: ["telegram:geeclaw"],
    });
  });

  it("fails closed instead of unioning tool policies across endpoints", () => {
    expect(() =>
      resolveHostRuntimeToolPolicy({
        ...createPreparedFact({ endpointId: "telegram:geeclaw" }),
        ...createPreparedFact({ endpointId: "slack:geeclaw" }),
      }),
    ).toThrow(
      'Externally hosted OpenClaw tool policy requires exactly one active endpoint; received endpoints "slack:geeclaw", "telegram:geeclaw".',
    );
  });
});
