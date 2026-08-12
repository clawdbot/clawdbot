import { describe, expect, it, vi } from "vitest";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import {
  combineChannelAdmissionEvidence,
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  createChannelParticipantAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionEvidence,
} from "./admission-evidence.js";
import { resolveStableChannelMessageIngress } from "./runtime.js";

async function buildAdmittedContext(participantId: string, allowFrom = [participantId]) {
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: "test",
    accountId: "acct:primary",
    subject: { stableId: participantId },
    conversation: { kind: "direct", id: "dm-1" },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom,
  });
  return buildChannelInboundEventContext({
    channel: "test",
    accountId: "acct:primary",
    messageId: "msg-1",
    from: "test:route:dm-1",
    sender: { id: participantId },
    conversation: { kind: "direct", id: "dm-1" },
    route: { agentId: "main", routeSessionKey: "agent:main:test:dm:dm-1" },
    reply: { to: "test:route:dm-1" },
    message: { rawBody: "hello" },
    channelIngress,
  });
}

describe("channel admission evidence", () => {
  it("carries the resolver participant to one run admission without route inference", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const context = await buildAdmittedContext("person:42");
      const evidence = readChannelContextAdmissionEvidence(context);
      const consumed = consumeChannelAdmissionEvidence(evidence);

      expect(consumed).toEqual({
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: '["test","acct:primary","person:42"]',
        },
        assuranceRef: "channel-admission",
        decisionCoverage: "enforced",
      });
      expect(Object.isFrozen(consumed)).toBe(true);
      expect(Object.isFrozen(consumed.invoker)).toBe(true);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
        decisionCoverage: "unknown",
      });
    } finally {
      cleanup();
    }
  });

  it("reports same-participant collection while mixed participants fail closed", () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const first = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        accountId: "a:b",
        participantId: "c",
      });
      const same = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        accountId: "a:b",
        participantId: "c",
      });
      const tupleCollisionCandidate = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        accountId: "a",
        participantId: "b:c",
      });

      expect(
        consumeChannelAdmissionEvidence(combineChannelAdmissionEvidence([first, same])),
      ).toEqual({
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: '["test","a:b","c"]',
        },
        assuranceRef: "channel-admission",
        decisionCoverage: "attribution-only",
      });
      expect(
        consumeChannelAdmissionEvidence(
          combineChannelAdmissionEvidence([
            createChannelParticipantAdmissionEvidence({
              channelId: "test",
              accountId: "a:b",
              participantId: "c",
            }),
            tupleCollisionCandidate,
          ]),
        ),
      ).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
        decisionCoverage: "unknown",
      });
    } finally {
      cleanup();
    }
  });

  it("keeps wildcard admission attribution-only because identity did not affect the outcome", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const context = await buildAdmittedContext("person-42", ["*"]);
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "attribution-only",
      });
    } finally {
      cleanup();
    }
  });

  it("rejects forged and prior-lifecycle carriers and stays empty when collection is disabled", () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    const stale = createChannelParticipantAdmissionEvidence({
      channelId: "test",
      participantId: "person-1",
    });
    cleanup();

    const nextCleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      expect(consumeChannelAdmissionEvidence(stale)).toMatchObject({ ingressState: "unknown" });
      expect(
        consumeChannelAdmissionEvidence({
          kind: "channel-admission-evidence",
        } as ChannelAdmissionEvidence),
      ).toMatchObject({ ingressState: "unknown" });
    } finally {
      nextCleanup();
    }

    expect(
      createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      }),
    ).toBeUndefined();
  });

  it("distinguishes unsupported, omitted, and mismatched adapter handoffs", () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const base = {
        channel: "legacy",
        accountId: "default",
        messageId: "msg-1",
        from: "legacy:route:room-1",
        sender: { id: "person-1" },
        conversation: { kind: "direct" as const, id: "room-1" },
        route: { agentId: "main", routeSessionKey: "agent:main:legacy:dm:room-1" },
        reply: { to: "legacy:route:room-1" },
        message: { rawBody: "hello" },
      };
      const unsupported = buildChannelInboundEventContext({
        ...base,
        channelIngress: "unsupported",
      });
      const omitted = buildChannelInboundEventContext(base);
      const mismatched = buildChannelInboundEventContext({
        ...base,
        channelParticipantEvidence: createChannelParticipantAdmissionEvidence({
          channelId: "legacy",
          accountId: "default",
          participantId: "someone-else",
        }),
      });

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(unsupported)),
      ).toMatchObject({ ingressState: "unsupported", decisionCoverage: "unsupported" });
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(omitted)),
      ).toMatchObject({
        ingressState: "unknown",
        decisionCoverage: "unknown",
      });
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(mismatched)),
      ).toMatchObject({ ingressState: "unknown", decisionCoverage: "unknown" });
    } finally {
      cleanup();
    }
  });

  it("expires a carrier at the bounded retention edge", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const evidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      });
      vi.setSystemTime(1_000 + 30 * 24 * 60 * 60_000 + 1);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
        decisionCoverage: "unknown",
      });
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("bounds aggregate fan-in and participant material", () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const oversizedParticipant = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "x".repeat(4_097),
      });
      expect(consumeChannelAdmissionEvidence(oversizedParticipant)).toMatchObject({
        ingressState: "unknown",
      });

      const sources = Array.from({ length: 17 }, (_, index) =>
        createChannelParticipantAdmissionEvidence({
          channelId: "test",
          participantId: `person-${index}`,
        }),
      );
      expect(
        consumeChannelAdmissionEvidence(combineChannelAdmissionEvidence(sources)),
      ).toMatchObject({
        ingressState: "unknown",
      });
    } finally {
      cleanup();
    }
  });
});
