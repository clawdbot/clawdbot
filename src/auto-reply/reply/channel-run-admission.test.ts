import { describe, expect, it } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import {
  configureChannelAdmissionDecisionSink,
  configureChannelAdmissionEvidenceCollection,
  consumeChannelAdmissionEvidence,
} from "../../channels/message-access/admission-evidence.js";
import { consumeChannelRunAdmission, prepareChannelRunAdmission } from "./channel-run-admission.js";

const identityConfig = { logging: { audit: { executionIdentity: true } } } as const;

describe("channel run admission", () => {
  it("projects a hardened channel handoff as boundary-verified assurance", () => {
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    try {
      const evidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      });

      expect(consumeChannelRunAdmission(evidence).facts).toMatchObject({
        invoker: { state: "present", kind: "person" },
        assurance: [
          {
            kind: "channel-admission",
            rawEvidenceRef: "channel-admission",
            strength: "boundary-verified",
          },
        ],
      });
    } finally {
      clearCollection();
    }
  });

  it("consumes once across fallback admission and closes the exact prepared owner", async () => {
    const identityWork: unknown[] = [];
    const decisions: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearIdentitySink = configureExecutionIdentityAdmissionSink((work) => {
      identityWork.push(work);
      return true;
    });
    const clearDecisionSink = configureChannelAdmissionDecisionSink((receipt) => {
      decisions.push(receipt);
      return true;
    });
    try {
      const evidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      });
      const prepared = prepareChannelRunAdmission({
        cfg: identityConfig,
        runId: "run-1",
        agentId: "main",
        ingressKind: "channel",
        boundary: "test.channel",
        evidence,
      });

      const first = await prepared.admit("embedded");
      const fallback = await prepared.admit("embedded");

      expect(fallback).toBe(first);
      expect(identityWork).toHaveLength(1);
      expect(decisions).toHaveLength(1);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
      });

      prepared.close();
      await expect(prepared.admit("embedded")).rejects.toThrow(
        "prepared execution context is already closed",
      );
    } finally {
      clearDecisionSink();
      clearIdentitySink();
      clearCollection();
    }
  });

  it("does not consume a cancelled pre-admission carrier or label internal ACP as a person", async () => {
    const identityWork: unknown[] = [];
    const clearCollection = configureChannelAdmissionEvidenceCollection(true);
    const clearIdentitySink = configureExecutionIdentityAdmissionSink((work) => {
      identityWork.push(work);
      return true;
    });
    try {
      const evidence = createChannelParticipantAdmissionEvidence({
        channelId: "test",
        participantId: "person-1",
      });
      const cancelled = prepareChannelRunAdmission({
        cfg: identityConfig,
        runId: "cancelled-run",
        agentId: "main",
        ingressKind: "channel",
        boundary: "test.channel",
        evidence,
      });
      cancelled.close();
      await expect(cancelled.admit("embedded")).rejects.toThrow(
        "prepared execution context is already closed",
      );
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "present",
      });

      const internalAcp = prepareAgentRunAdmission({
        cfg: identityConfig,
        operationalRunInstance: createOperationalRunInstanceRef("internal-acp"),
        facts: {
          runId: "internal-acp",
          agentId: "main",
          ingress: { kind: "acp", boundary: "test.internal", state: "present" },
        },
      });
      await internalAcp.admit("acp");
      internalAcp.close();

      expect(identityWork).toHaveLength(1);
      expect(identityWork).toMatchObject([{ kind: "capture", envelope: {} }]);
      expect(
        (identityWork[0] as { envelope?: { invoker?: unknown } }).envelope?.invoker,
      ).toBeUndefined();
    } finally {
      clearIdentitySink();
      clearCollection();
    }
  });
});
