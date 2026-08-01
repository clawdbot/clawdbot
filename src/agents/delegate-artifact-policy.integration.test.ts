import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContinuationRuntimeConfig,
  PendingContinuationDelegate,
} from "../auto-reply/continuation/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const sessionIds = vi.hoisted(() => new Map<string, string>());
const registryRuns = vi.hoisted(() => new Map<string, SubagentRunRecord>());

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntry: ({ sessionKey }: { sessionKey: string }) => {
      const sessionId = sessionIds.get(sessionKey);
      return sessionId ? { sessionId, updatedAt: 1 } : undefined;
    },
  };
});

vi.mock("./subagent-registry-announce-read.js", async () => {
  const { listAncestorSessionKeysFromRuns } = await import("./subagent-registry-queries.js");
  return {
    listAncestorSessionKeys: (sessionKey: string) =>
      listAncestorSessionKeysFromRuns(registryRuns, sessionKey),
  };
});

const { prepareDelegateArtifactPolicy } = await import("./delegate-artifact-policy.js");
const { finalizeDelegateArtifacts, publishDelegateArtifactCandidates } =
  await import("./delegate-artifacts.js");

const rootSessionKey = "agent:main:root";
const orchestratorSessionKey = "agent:main:subagent:orchestrator";
const siblingSessionKey = "agent:main:subagent:sibling";
const guessedSessionKey = "agent:main:guessed";

function runRecord(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  createdAt: number;
}): SubagentRunRecord {
  return {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: params.requesterSessionKey,
    task: "tree",
    cleanup: "keep",
    createdAt: params.createdAt,
    execution: { status: "running", startedAt: params.createdAt },
  };
}

const runtimeConfig: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 15_000,
  minDelayMs: 5_000,
  maxDelayMs: 300_000,
  maxChainLength: 10,
  costCapTokens: 500_000,
  maxDelegatesPerTurn: 5,
  maxPendingWork: 10,
  crossSessionTargeting: "disabled",
};

const delegate: PendingContinuationDelegate = {
  task: "return a managed artifact to causal ancestors",
  mode: "silent-wake",
  fanoutMode: "tree",
  returnOptions: { artifacts: "optional" },
  recipientContext: { purpose: "Use the result in the causal ancestor session." },
};

describe("delegate artifact tree policy integration", () => {
  beforeEach(() => {
    sessionIds.clear();
    registryRuns.clear();
    sessionIds.set(rootSessionKey, "root-session-v1");
    sessionIds.set(orchestratorSessionKey, "orchestrator-session-v1");
    sessionIds.set(siblingSessionKey, "sibling-session-v1");
    sessionIds.set(guessedSessionKey, "guessed-session-v1");
    registryRuns.set(
      "run-orchestrator",
      runRecord({
        runId: "run-orchestrator",
        childSessionKey: orchestratorSessionKey,
        requesterSessionKey: rootSessionKey,
        createdAt: 1,
      }),
    );
    registryRuns.set(
      "run-sibling",
      runRecord({
        runId: "run-sibling",
        childSessionKey: siblingSessionKey,
        requesterSessionKey: rootSessionKey,
        createdAt: 2,
      }),
    );
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("freezes only causal ancestors and rejects later sibling, guessed, and incarnation drift", async () => {
    await withTempDir({ prefix: "openclaw-tree-artifact-policy-" }, async (stateDir) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const cfg: OpenClawConfig = {
        session: { store: `${stateDir}/sessions.sqlite` },
      };
      prepareDelegateArtifactPolicy({
        cfg,
        config: runtimeConfig,
        dispatchingSessionKey: orchestratorSessionKey,
        delegate,
        flowId: "tree-flow",
        dispatchRevision: 1,
        acceptedAt: 1_000,
      });

      const db = openOpenClawStateDatabase().db;
      const accepted = db
        .prepare(
          "SELECT producer_session_key, producer_run_id, recipients_json FROM delegate_artifact_policies WHERE flow_id = ?",
        )
        .get("tree-flow") as {
        producer_session_key: string;
        producer_run_id: string;
        recipients_json: string;
      };
      expect(JSON.parse(accepted.recipients_json)).toEqual([
        {
          sessionKey: rootSessionKey,
          sessionId: "root-session-v1",
          relation: "inter_session",
          purpose: "Use the result in the causal ancestor session.",
        },
        {
          sessionKey: orchestratorSessionKey,
          sessionId: "orchestrator-session-v1",
          relation: "parent",
        },
      ]);

      registryRuns.set(
        "run-orchestrator-rebound",
        runRecord({
          runId: "run-orchestrator-rebound",
          childSessionKey: orchestratorSessionKey,
          requesterSessionKey: guessedSessionKey,
          createdAt: 3,
        }),
      );
      sessionIds.set(rootSessionKey, "root-session-v2");

      expect(
        publishDelegateArtifactCandidates({
          producerSessionKey: accepted.producer_session_key,
          producerSessionId: "producer-session-v1",
          producerRunId: accepted.producer_run_id,
          publicationKey: "publish-tree",
          candidates: [{ bytes: Buffer.from("tree artifact"), mimeType: "text/plain" }],
          runtimeEnabled: true,
          crossSessionEnabled: false,
          now: 2_000,
        }),
      ).toEqual({ status: "published", count: 1 });
      const finalized = finalizeDelegateArtifacts({
        producerSessionKey: accepted.producer_session_key,
        producerSessionId: "producer-session-v1",
        producerRunId: accepted.producer_run_id,
        completionId: "completion-tree",
        finalizationKey: "finalize-tree",
        completionStatus: "ok",
        completedAt: 3_000,
        silent: true,
        runtimeEnabled: true,
        crossSessionEnabled: false,
        resolveSessionId: (sessionKey) => sessionIds.get(sessionKey),
        now: 3_100,
      });

      expect(finalized.status).toBe("finalized");
      if (finalized.status !== "finalized") {
        throw new Error("expected finalized tree policy");
      }
      expect([...finalized.projections.keys()]).toEqual([orchestratorSessionKey]);
      expect(
        db
          .prepare(
            "SELECT recipient_session_key, recipient_session_id, outcome, unavailable_reason FROM delegate_artifact_recipient_outcomes ORDER BY recipient_session_key",
          )
          .all(),
      ).toEqual([
        {
          recipient_session_key: rootSessionKey,
          recipient_session_id: "root-session-v1",
          outcome: "unavailable",
          unavailable_reason: "recipient-incarnation-changed",
        },
        {
          recipient_session_key: orchestratorSessionKey,
          recipient_session_id: "orchestrator-session-v1",
          outcome: "available",
          unavailable_reason: null,
        },
      ]);
      expect(accepted.recipients_json).not.toContain(siblingSessionKey);
      expect(accepted.recipients_json).not.toContain(guessedSessionKey);
    });
  });
});
