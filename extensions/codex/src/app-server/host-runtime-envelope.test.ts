import { describe, expect, it } from "vitest";
import {
  buildHostRuntimePreparedFacts,
  HostRuntimeEnvelopeValidationError,
  type HostRuntimeEnvelope,
} from "./host-runtime-envelope.js";
import type { TurnOwnerDecision } from "./mcp-thread-config.js";

const GEE_ENDPOINT_ID = "telegram:geeclaw";

function createhostDecision(): TurnOwnerDecision {
  return {
    owner: "external-host",
    reason: "endpoint-owner",
    endpointId: GEE_ENDPOINT_ID,
    threadOwnerId: "geeclaw",
    hostId: "geeclaw",
    auditId: "audit-geeclaw-telegram",
  };
}

function createHostRuntimeEnvelope(): HostRuntimeEnvelope {
  return {
    kind: "host-runtime-envelope",
    version: 1,
    owner: "external-host",
    hostId: "geeclaw",
    requestId: "request-123",
    auditId: "audit-geeclaw-telegram",
    endpoint: {
      channel: "telegram",
      accountId: "telegram:bot:geeclaw",
      endpointId: GEE_ENDPOINT_ID,
      externalIdentity: "@geeclaw",
    },
    conversation: {
      sessionKey: "telegram:geeclaw:user-42",
      threadId: "thread-123",
      threadOwner: "external-host",
    },
    provider: {
      modelRef: "codex:gpt-5.4",
      routingPolicyId: "gee-provider-default",
      fallbackPolicyId: "gee-fallback-default",
      cooldownPolicyId: "gee-cooldown-default",
    },
    auth: {
      credentialRef: "gee://credentials/openai/work",
      eligibility: "ok",
    },
    tools: {
      capabilityPlanId: "gee-tools-default",
      allowedToolIds: ["message.send", "memory.search"],
      policy: "host-authorized",
    },
    delivery: {
      policyId: "gee-native-outbox",
      accountId: "telegram:bot:geeclaw",
      outboundTarget: "telegram:chat:42",
      confirmationPolicy: "native-outbox-only",
    },
    compaction: {
      owner: "external-host",
      hostCompactionId: "gee-compaction-default",
    },
  };
}

describe("Host runtime envelope prepared facts", () => {
  it("builds stable prepared facts for Externally hosted OpenClaw turns", () => {
    const result = buildHostRuntimePreparedFacts({
      ownershipDecisions: { [GEE_ENDPOINT_ID]: createhostDecision() },
      envelopeSources: { [GEE_ENDPOINT_ID]: createHostRuntimeEnvelope() },
    });

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preparedFacts).toEqual({
      [GEE_ENDPOINT_ID]: {
        kind: "host-runtime-prepared-facts",
        version: 1,
        hostMode: "external-hosted",
        envelope: createHostRuntimeEnvelope(),
      },
    });
    expect(result.serialized).toMatchObject({
      [GEE_ENDPOINT_ID]: {
        hostMode: "external-hosted",
        envelope: {
          owner: "external-host",
          endpoint: { endpointId: GEE_ENDPOINT_ID },
          auth: { credentialRef: "gee://credentials/openai/work" },
        },
      },
    });
  });

  it.each(["provider", "auth", "tools", "delivery", "compaction"] as const)(
    "fails closed when Externally hosted turns are missing %s facts",
    (fieldName) => {
      const envelope = createHostRuntimeEnvelope() as Record<string, unknown>;
      delete envelope[fieldName];

      expect(() =>
        buildHostRuntimePreparedFacts({
          ownershipDecisions: { [GEE_ENDPOINT_ID]: createhostDecision() },
          envelopeSources: { [GEE_ENDPOINT_ID]: envelope },
        }),
      ).toThrow(HostRuntimeEnvelopeValidationError);
      try {
        buildHostRuntimePreparedFacts({
          ownershipDecisions: { [GEE_ENDPOINT_ID]: createhostDecision() },
          envelopeSources: { [GEE_ENDPOINT_ID]: envelope },
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "openclaw_host_runtime_missing_fact",
          endpointId: GEE_ENDPOINT_ID,
          fieldName,
        });
      }
    },
  );

  it("rejects raw credential material in hosted auth facts", () => {
    const envelope = createHostRuntimeEnvelope();
    const rawEnvelope = {
      ...envelope,
      auth: { ...envelope.auth, apiKey: "sk-raw-secret" },
    };

    expect(() =>
      buildHostRuntimePreparedFacts({
        ownershipDecisions: { [GEE_ENDPOINT_ID]: createhostDecision() },
        envelopeSources: { [GEE_ENDPOINT_ID]: rawEnvelope },
      }),
    ).toThrow(HostRuntimeEnvelopeValidationError);
  });

  it("does not require host state for standalone OpenClaw ownership decisions", () => {
    const result = buildHostRuntimePreparedFacts({
      ownershipDecisions: {
        "local-acp": {
          owner: "openclaw",
          reason: "standalone-default",
          endpointId: "local-acp",
          auditId: "mcp:local-acp",
        },
      },
    });

    expect(result).toEqual({});
  });
});
