import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  finalizeDelegateArtifacts,
  publishDelegateArtifactCandidates,
  type DelegateArtifactPolicyV1,
} from "./delegate-artifacts.js";

export function stateOptions() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-delegate-artifacts-"));
  return { path: join(directory, "openclaw.sqlite") };
}

export function policy(
  overrides: Partial<DelegateArtifactPolicyV1> = {},
): DelegateArtifactPolicyV1 {
  return {
    flowId: "flow-1",
    producerSessionKey: "agent:main:subagent:continuation-child",
    producerRunId: "continuation-delegate-run-1",
    originParentSessionKey: "agent:main:parent",
    originParentSessionId: "parent-session-1",
    dispatchRevision: 4,
    dispatchAcceptedAt: 1_000,
    scheduledAt: 1_100,
    notBefore: 31_100,
    artifactMode: "optional",
    recipients: [
      {
        sessionKey: "agent:main:parent",
        sessionId: "parent-session-1",
        relation: "parent",
      },
      {
        sessionKey: "agent:main:target",
        sessionId: "target-session-1",
        relation: "inter_session",
        purpose: "Compare the generated report with the target's current plan.",
      },
    ],
    route: { kind: "targets", targetSessionKeys: ["agent:main:parent", "agent:main:target"] },
    recipientContext: "Compare the generated report with the target's current plan.",
    ...overrides,
  };
}

export function publish(
  options: ReturnType<typeof stateOptions>,
  publicationKey = "tool-call-1",
  producerRunId = "continuation-delegate-run-1",
) {
  return publishDelegateArtifactCandidates({
    producerSessionKey: "agent:main:subagent:continuation-child",
    producerSessionId: "child-session-1",
    producerRunId,
    publicationKey,
    candidates: [{ bytes: Buffer.from("%PDF-1.7 delegate report"), mimeType: "application/pdf" }],
    runtimeEnabled: true,
    crossSessionEnabled: true,
    now: 2_000,
    options,
  });
}

export function finalize(
  options: ReturnType<typeof stateOptions>,
  overrides: Partial<Parameters<typeof finalizeDelegateArtifacts>[0]> = {},
) {
  const sessionIds = new Map([
    ["agent:main:parent", "parent-session-1"],
    ["agent:main:target", "target-session-1"],
  ]);
  return finalizeDelegateArtifacts({
    producerSessionKey: "agent:main:subagent:continuation-child",
    producerSessionId: "child-session-1",
    producerRunId: "continuation-delegate-run-1",
    completionId: "completion-1",
    finalizationKey: "finalization-1",
    completionStatus: "ok",
    completedAt: 9_000,
    silent: true,
    runtimeEnabled: true,
    crossSessionEnabled: true,
    resolveSessionId: (sessionKey) => sessionIds.get(sessionKey),
    now: 10_000,
    options,
    ...overrides,
  });
}
