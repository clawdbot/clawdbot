import { describe, expect, it, vi } from "vitest";
import {
  buildChannelInboundEventContext,
  buildHostChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  combineChannelAdmissionEvidence,
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
  copyChannelParticipantAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  registerChannelAdmissionEvidenceOwner,
  type ChannelAdmissionEvidence,
} from "./admission-evidence.js";
import { resolveStableChannelMessageIngress } from "./runtime.js";

async function buildAdmittedContext(participantId: string, allowFrom = [participantId]) {
  const record = {};
  const epoch = {};
  const owner = { channelId: "test", record, epoch, isLive: () => true };
  const dispose = registerChannelAdmissionEvidenceOwner(owner);
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: "test",
    accountId: "acct:primary",
    subject: { stableId: participantId },
    conversation: { kind: "direct", id: "dm-1" },
    contextBinding: {
      agentId: "main",
      sessionKey: "agent:main:test:dm:dm-1",
      messageId: "msg-1",
      inboundEventKind: "user_request",
    },
    dmPolicy: "allowlist",
    groupPolicy: "allowlist",
    allowFrom,
  });
  try {
    const buildContext = createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    );
    return buildContext({
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
  } finally {
    dispose();
  }
}

function inspectChannelContext(context: object) {
  return consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context));
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

  it("rejects copying one participant carrier onto another participant context", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const source = await buildAdmittedContext("person-a");
      const target = { ...source, SenderId: "person-b" };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(target)),
      ).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("cannot bootstrap evidence through the public copy helper", () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const source = { OriginatingChannel: "test", AccountId: "default", SenderId: "person-a" };
      const target = { ...source };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(readChannelContextAdmissionEvidence(target)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("preserves evidence only across a same-identity public copy", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const source = await buildAdmittedContext("person-a");
      const target = { ...source };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(inspectChannelContext(target)).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
      });
    } finally {
      cleanup();
    }
  });

  it.each([
    ["route", { SessionKey: "agent:other:test:dm:dm-1" }],
    ["thread", { MessageThreadId: "thread-2" }],
    ["native channel", { NativeChannelId: "native-2" }],
    ["message", { MessageSid: "msg-2", MessageSidFull: "msg-2" }],
  ])("degrades a carrier copied across changed %s scope", async (_name, patch) => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const source = await buildAdmittedContext("person-a");
      const target = { ...source, ...patch };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(inspectChannelContext(target)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("cannot revive a carrier through a same-scope copy after run admission", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const source = await buildAdmittedContext("person-a");
      expect(inspectChannelContext(source)).toMatchObject({ ingressState: "present" });
      const target = { ...source };

      copyChannelParticipantAdmissionEvidence(source, target);

      expect(inspectChannelContext(target)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      cleanup();
    }
  });

  it("reports same-participant collection while mixed participants fail closed", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const first = readChannelContextAdmissionEvidence(await buildAdmittedContext("c"));
      const same = readChannelContextAdmissionEvidence(await buildAdmittedContext("c"));
      const tupleCollisionCandidate = readChannelContextAdmissionEvidence(
        await buildAdmittedContext("b:c"),
      );

      expect(
        consumeChannelAdmissionEvidence(combineChannelAdmissionEvidence([first, same])),
      ).toEqual({
        ingressState: "present",
        invoker: {
          state: "present",
          kind: "person",
          rawPrincipalRef: '["test","acct:primary","c"]',
        },
        assuranceRef: "channel-admission",
        decisionCoverage: "enforced",
      });
      expect(
        consumeChannelAdmissionEvidence(
          combineChannelAdmissionEvidence([
            readChannelContextAdmissionEvidence(await buildAdmittedContext("c")),
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

  it("rejects forged and prior-lifecycle carriers and stays empty when collection is disabled", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    const stale = readChannelContextAdmissionEvidence(await buildAdmittedContext("person-1"));
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
      readChannelContextAdmissionEvidence(await buildAdmittedContext("person-1")),
    ).toBeUndefined();
  });

  it("distinguishes unsupported, omitted, and structurally fake adapter handoffs", async () => {
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
      const unsupported = buildHostChannelInboundEventContext({
        ...base,
        channelIngress: "unsupported",
      });
      const omitted = buildHostChannelInboundEventContext(base);
      const exact = await resolveStableChannelMessageIngress({
        channelId: "legacy",
        accountId: "default",
        subject: { stableId: "person-1" },
        conversation: { kind: "direct", id: "room-1" },
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:legacy:dm:room-1",
          messageId: "msg-1",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
      });
      const mismatched = buildHostChannelInboundEventContext({
        ...base,
        channelIngress: { ...exact },
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

  it("keeps ordinary public and ownerless host builders non-authoritative", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    const owner = { channelId: "public-test", record: {}, epoch: {}, isLive: () => true };
    const dispose = registerChannelAdmissionEvidenceOwner(owner);
    try {
      const ingress = await resolveStableChannelMessageIngress({
        channelId: "public-test",
        accountId: "default",
        subject: { stableId: "person-1" },
        conversation: { kind: "direct", id: "dm-1" },
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:public-test:dm:dm-1",
          inboundEventKind: "user_request",
        },
        dmPolicy: "open",
      });
      const params = {
        channel: "public-test",
        accountId: "default",
        from: "public-test:dm-1",
        sender: { id: "person-1" },
        conversation: { kind: "direct" as const, id: "dm-1" },
        route: { agentId: "main", routeSessionKey: "agent:main:public-test:dm:dm-1" },
        reply: { to: "public-test:dm-1" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      };

      const publicContext = buildChannelInboundEventContext(params);
      expect(readChannelContextAdmissionEvidence(publicContext)).toBeUndefined();
      const ownerlessContext = buildHostChannelInboundEventContext(params);
      expect(inspectChannelContext(ownerlessContext)).toMatchObject({
        ingressState: "unknown",
        invoker: { state: "unknown" },
      });
    } finally {
      dispose();
      cleanup();
    }
  });

  it("expires a carrier at the bounded retention edge", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const evidence = readChannelContextAdmissionEvidence(await buildAdmittedContext("person-1"));
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

  it("bounds aggregate fan-in and participant material", async () => {
    const cleanup = configureChannelAdmissionEvidenceCollection(true);
    try {
      const oversizedParticipant = readChannelContextAdmissionEvidence(
        await buildAdmittedContext("x".repeat(4_097)),
      );
      expect(consumeChannelAdmissionEvidence(oversizedParticipant)).toMatchObject({
        ingressState: "unknown",
      });

      const sources = await Promise.all(
        Array.from({ length: 17 }, async (_, index) =>
          readChannelContextAdmissionEvidence(await buildAdmittedContext(`person-${index}`)),
        ),
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
