import { expect, it, vi } from "vitest";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  configureChannelAdmissionEvidenceCollection,
  readChannelContextAdmissionEvidence,
} from "./admission-evidence.js";
import { registerChannelIngressHostOwner } from "./ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "./runtime.js";

const recordParticipant = vi.hoisted(() => vi.fn());
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: recordParticipant,
}));

it.each(["qualified", "mixed", "reloaded", "stale", "retargeted", "denied"] as const)(
  "preserves accepted product identity and host ownership with audit disabled: %s",
  async (scenario) => {
    recordParticipant.mockClear();
    const stopAudit = configureChannelAdmissionEvidenceCollection(false);
    let live = true;
    const owner = { channelId: "test", record: {}, epoch: {}, isLive: () => live };
    const unregister = registerChannelIngressHostOwner(owner);
    const key = "agent:main:test:dm:conversation";
    const resolveParticipant = vi.fn((subject: { stableId?: string | number | null }) =>
      subject.stableId === "unknown"
        ? undefined
        : {
            domain: "workspace-one",
            idKind: "user-id",
            id: String(subject.stableId),
          },
    );
    try {
      const sources =
        scenario === "mixed" ? ["profile-collision", "unknown"] : ["profile-collision"];
      if (scenario === "reloaded") {
        vi.resetModules();
      }
      const resolveIngress =
        scenario === "reloaded"
          ? (await import("./runtime.js")).resolveStableChannelMessageIngress
          : resolveStableChannelMessageIngress;
      const ingress = [];
      const startedAt = Date.now();
      for (const sender of sources) {
        ingress.push(
          await resolveIngress({
            channelId: "test",
            accountId: "local",
            identity: { resolveParticipant },
            subject: { stableId: sender },
            conversation: { kind: "direct", id: "conversation" },
            contextBinding: {
              agentId: "main",
              sessionKey: key,
              messageId: sender,
              inboundEventKind: "user_request",
            },
            dmPolicy: "open",
            groupPolicy: "disabled",
            allowFrom: scenario === "denied" ? [] : ["*"],
            useDefaultPairingStore: false,
          }),
        );
      }
      expect(resolveParticipant).toHaveBeenCalledTimes(sources.length);
      expect(ingress[0]?.ingress.admission).toBe(scenario === "denied" ? "drop" : "dispatch");
      live = scenario !== "stale";
      const context = await createHostChannelInboundEventContextBuilder(
        buildChannelInboundEventContext,
        owner,
      )({
        channel: "test",
        accountId: "local",
        messageId: sources.at(-1),
        from: "test:conversation",
        sender: { id: sources.at(-1) },
        conversation: { kind: "direct", id: "conversation" },
        route: {
          agentId: "main",
          routeSessionKey: scenario === "retargeted" ? "agent:main:other" : key,
        },
        reply: { to: "test:conversation" },
        message: { rawBody: "hello" },
        channelIngress: ingress,
      });
      const target = { agentId: "main", sessionKey: key, storePath: "/unused" };
      recordAcceptedSessionParticipantInput({ ...context }, target);
      recordAcceptedSessionParticipantInput(context, target);
      if (scenario === "qualified" || scenario === "mixed" || scenario === "reloaded") {
        expect(recordParticipant).toHaveBeenCalledTimes(sources.length);
        expect(recordParticipant).toHaveBeenNthCalledWith(1, {
          ...target,
          identity: {
            type: "remote",
            pluginId: "test",
            domain: "workspace-one",
            idKind: "user-id",
            id: "profile-collision",
          },
          promptedAt: expect.any(Number),
        });
        expect(recordParticipant.mock.calls[0]?.[0].promptedAt).toBeGreaterThanOrEqual(startedAt);
        if (scenario === "mixed") {
          expect(recordParticipant).toHaveBeenNthCalledWith(2, {
            ...target,
            identity: {
              type: "observation",
              pluginId: "test",
              accountId: "local",
              senderKind: "unknown",
              id: "unknown",
            },
            promptedAt: expect.any(Number),
          });
        }
      } else {
        expect(recordParticipant).not.toHaveBeenCalled();
      }
      expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
      expect(ingress[0]).not.toHaveProperty("participant");
    } finally {
      unregister();
      stopAudit();
    }
  },
);
