import { describe, expect, it } from "vitest";
import { parseTranscriptPolicyArchive } from "./session-transcript-policy-archive.js";

function archive(
  params: { agentId?: string; mutate?: (record: Record<string, unknown>) => void } = {},
) {
  const record: Record<string, unknown> = {
    agentId: params.agentId ?? "main",
    type: "openclaw.memory-policy-archive-v1",
    version: 1,
    sessionId: "session-1",
    eventSeq: 0,
    subject: {
      sessionKey: "agent:main:session-1",
      sessionIdentityRevision: "identity-1",
      subjectRevision: "subject-1",
    },
    policy: {
      contextFingerprint: "context-1",
      deliveryAudiencesJson: '[{"id":"alice","kind":"user"}]',
      runExposureRevision: 1,
      runExposureSetId: "exposure-1",
      runId: "run-1",
      sourcePolicySetId: "policy-set-1",
    },
    detail: {
      actorEvidenceJson: '{"version":1}',
      delegationSnapshotJson: '{"kind":"none","version":1}',
      egressReceiptIdsJson: '["egress-1"]',
      exposedResourceRevisionsJson: '["resource-1"]',
      exposureReceiptIdsJson: '["receipt-1"]',
      finalizedDeliveryAudiencesJson: '[{"id":"alice","kind":"user"}]',
      normalizedAudienceIntersectionJson: '[{"id":"alice","kind":"user"}]',
      sourceEventSeq: 0,
      sourceSessionId: "session-1",
    },
  };
  params.mutate?.(record);
  return `${JSON.stringify({ id: "event-1", type: "message" })}\n${JSON.stringify(record)}\n`;
}

describe("transcript policy archive", () => {
  it("accepts canonical event and companion pairs", () => {
    expect(parseTranscriptPolicyArchive(archive())).toMatchObject({
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      events: [{ eventSeq: 0, eventJson: '{"id":"event-1","type":"message"}' }],
    });
  });

  it.each([
    ["legacy raw JSONL", '{"id":"event-1","type":"message"}\n'],
    [
      "missing immutable subject key",
      archive({
        mutate: (record) => delete (record.subject as Record<string, unknown>).sessionKey,
      }),
    ],
    ["cross-owner companion", `${archive()}${archive({ agentId: "other" })}`],
  ])("rejects %s", (_name, content) => {
    expect(parseTranscriptPolicyArchive(content)).toBeUndefined();
  });
});
