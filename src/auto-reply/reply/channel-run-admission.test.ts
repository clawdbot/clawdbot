import { describe, expect, it } from "vitest";
import { createChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { configureExecutionIdentityAdmissionSink } from "../../audit/execution-identity-admission.js";
import {
  combineChannelAdmissionEvidence,
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
    const admittedContexts: unknown[] = [];
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
        onAdmitted: (context) => admittedContexts.push(context),
      });

      expect(() => prepared.assertSourceCurrent()).not.toThrow();
      expect(identityWork).toHaveLength(0);
      const first = await prepared.admit("embedded");
      const fallback = await prepared.admit("embedded");

      expect(fallback).toBe(first);
      expect(identityWork).toHaveLength(1);
      expect(decisions).toHaveLength(1);
      expect(admittedContexts).toEqual([first]);
      expect(decisions).toMatchObject([
        {
          decision: { reasonCode: "channel_ingress_attribution_only" },
          enforcement: { policyRefs: [], contextFieldsUsed: [] },
        },
      ]);
      expect(consumeChannelAdmissionEvidence(evidence)).toMatchObject({
        ingressState: "unknown",
      });

      prepared.close();
      expect(() => prepared.assertSourceCurrent()).not.toThrow();
      await expect(prepared.admit("embedded")).rejects.toThrow(
        "prepared execution context is already closed",
      );
    } finally {
      clearDecisionSink();
      clearIdentitySink();
      clearCollection();
    }
  });

  it.each([false, true])(
    "explains identifier-authentication effects in the receipt with an unevaluated contribution: %s",
    async (includeUnevaluated) => {
      const decisions: unknown[] = [];
      const clearCollection = configureChannelAdmissionEvidenceCollection(true);
      const clearIdentitySink = configureExecutionIdentityAdmissionSink(() => true);
      const clearDecisionSink = configureChannelAdmissionDecisionSink((receipt) => {
        decisions.push(receipt);
        return true;
      });
      try {
        const prepared = prepareChannelRunAdmission({
          cfg: identityConfig,
          runId: "run-auth",
          agentId: "main",
          ingressKind: "channel",
          boundary: "test.channel",
          evidence: combineChannelAdmissionEvidence(
            (includeUnevaluated
              ? (["affected", "not-evaluated"] as const)
              : (["affected"] as const)
            ).map((identifierAuthentication) =>
              createChannelParticipantAdmissionEvidence({
                channelId: "test",
                participantId: "private-person-value",
                identifierAuthentication,
              }),
            ),
          ),
        });

        await prepared.admit("embedded");

        expect(decisions).toEqual([
          expect.objectContaining({
            receiptId: expect.stringContaining(":channel-admission"),
            decision: expect.objectContaining({
              reasonCode: "channel_ingress_identifier_authentication_applied",
            }),
            enforcement: expect.objectContaining({
              policyRefs: ["channel.identifier-authentication"],
              contextFieldsUsed: ["channel.identifier-authentication"],
            }),
          }),
        ]);
        expect(JSON.stringify(decisions)).not.toContain("private-person-value");
      } finally {
        clearDecisionSink();
        clearIdentitySink();
        clearCollection();
      }
    },
  );

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
