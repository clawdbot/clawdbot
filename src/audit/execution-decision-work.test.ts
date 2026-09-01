import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createAuditEventWriter } from "./audit-event-writer.js";
import { pageExecutionDecisionFactsForContext } from "./execution-decision-facts.js";
import type { ExecutionDecisionWork } from "./execution-decision-work.js";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "./execution-identity-admission.js";

function decisionWork(params: {
  token: ReturnType<typeof createExecutionIdentityAdmissionToken>;
  receiptId: string;
  rawResource: string;
  rawTarget: string;
  targetNamespace?: "model-route" | "session";
}): ExecutionDecisionWork {
  return {
    workVersion: 1,
    token: params.token,
    receipt: {
      schemaVersion: 1,
      receiptId: params.receiptId,
      occurredAt: params.token.createdAt + 1,
      action: {
        family: "model-routing",
        operation: "select",
        summary: "Selected one admitted model route.",
      },
      decision: { outcome: "allowed", reasonCode: "model_route_selected" },
      enforcement: {
        coverageState: "attribution-only",
        policyRefs: [],
        grantRefs: [],
        contextFieldsUsed: ["contextId", "executionId", "runId"],
      },
      source: {
        owner: "model-routing",
        recordRef: params.receiptId,
        decisionBoundary: "agent-runtime.post-admission",
      },
      missingEvidence: [],
      remediation: [],
    },
    refs: {
      resource: { namespace: "credential-profile", value: params.rawResource },
      target: { namespace: params.targetNamespace ?? "model-route", value: params.rawTarget },
    },
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("private execution decision work", () => {
  it.each(["raw ref", "complete envelope"] as const)(
    "rejects an oversized %s before the FIFO clone boundary",
    async (oversizedPart) => {
      const stateDir = tempDirs.make("openclaw-audit-private-decision-bounds-");
      const errors: string[] = [];
      const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
      const token = createExecutionIdentityAdmissionToken("bounded-private-decision-run", {
        contextId: "bounded-private-decision-context",
        executionId: "bounded-private-decision-execution",
        now: 1_000,
      });
      const work = decisionWork({
        token,
        receiptId: "bounded-private-decision",
        rawResource: oversizedPart === "raw ref" ? "r".repeat(4_097) : "resource",
        rawTarget: "target",
      });
      if (oversizedPart === "complete envelope") {
        const refs = Array.from({ length: 16 }, (_, index) => `${index}:`.padEnd(256, "p"));
        work.receipt.enforcement.policyRefs = refs;
        work.receipt.enforcement.grantRefs = refs;
        work.receipt.enforcement.contextFieldsUsed = refs;
        work.receipt.missingEvidence = refs;
        work.receipt.remediation = Array.from({ length: 8 }, (_, index) => ({
          code: `repair-${index}`,
          text: "r".repeat(512),
        }));
      }

      await writer.ready;
      const clone = vi.spyOn(globalThis, "structuredClone");
      expect(writer.recordExecutionDecisionWork(work)).toBe(false);
      expect(clone).not.toHaveBeenCalled();
      clone.mockRestore();
      await writer.stop();

      expect(errors).toEqual(["audit execution decision receipt could not be queued"]);
    },
  );

  it("projects private refs inside the admission FIFO without retaining raw owners", async () => {
    const stateDir = tempDirs.make("openclaw-audit-private-decision-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    const admittedAt = Date.now();
    const token = createExecutionIdentityAdmissionToken("private-decision-run", {
      contextId: "private-decision-context",
      executionId: "private-decision-execution",
      now: admittedAt,
    });
    const rawCredentialProfile = "openai:user@example.test";
    const rawModelTarget = "openai\0gpt-5.6-sol";
    const clearAdmissionSink = configureExecutionIdentityAdmissionSink(
      writer.recordExecutionIdentity,
    );

    await writer.ready;
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: token.runId,
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, token, runtimeInstanceId: "private-decision-runtime" },
      )?.accepted,
    ).toBe(true);
    expect(
      writer.recordExecutionDecisionWork(
        decisionWork({
          token,
          receiptId: "private-model-route",
          rawResource: rawCredentialProfile,
          rawTarget: rawModelTarget,
        }),
      ),
    ).toBe(true);
    clearAdmissionSink();
    await writer.stop();

    expect(errors).toEqual([]);
    const [receipt] = pageExecutionDecisionFactsForContext({
      context: token,
      limit: 10,
      now: admittedAt + 1,
      database,
    }).receipts;
    expect(receipt).toMatchObject({
      contextId: token.contextId,
      executionId: token.executionId,
      runId: token.runId,
      action: {
        family: "model-routing",
        resourceRef: expect.stringMatching(/^hmac-sha256:v1:/u),
        targetRef: expect.stringMatching(/^hmac-sha256:v1:/u),
      },
    });
    expect(receipt?.action.resourceRef).not.toBe(receipt?.action.targetRef);
    const sqlite = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
      readOnly: true,
    });
    try {
      const persisted = JSON.stringify(
        sqlite
          .prepare("SELECT * FROM execution_decision_facts WHERE receipt_id = ?")
          .get("private-model-route"),
      );
      expect(persisted).not.toContain(rawCredentialProfile);
      expect(persisted).not.toContain(rawModelTarget);
    } finally {
      sqlite.close();
    }
  });

  it("keeps refs restart-stable, namespace-separated, and installation-local", async () => {
    const rawRef = "same-private-owner-ref";
    const firstStateDir = tempDirs.make("openclaw-audit-private-stability-");
    const write = async (params: {
      stateDir: string;
      suffix: string;
      targetNamespace?: "model-route" | "session";
    }) => {
      const now = Date.now();
      const token = createExecutionIdentityAdmissionToken(`run-${params.suffix}`, {
        contextId: `context-${params.suffix}`,
        executionId: `execution-${params.suffix}`,
        now,
      });
      const database = { env: { OPENCLAW_STATE_DIR: params.stateDir } };
      const writer = createAuditEventWriter({ stateDir: params.stateDir });
      const clearAdmissionSink = configureExecutionIdentityAdmissionSink(
        writer.recordExecutionIdentity,
      );
      await writer.ready;
      expect(
        enqueueExecutionIdentityContextAtAdmission(
          {
            runId: token.runId,
            agentId: "main",
            ingress: { kind: "local-cli", boundary: "agent-command.local" },
            runtime: { kind: "embedded" },
          },
          { enabled: true, token, runtimeInstanceId: `runtime-${params.suffix}` },
        )?.accepted,
      ).toBe(true);
      expect(
        writer.recordExecutionDecisionWork(
          decisionWork({
            token,
            receiptId: `receipt-${params.suffix}`,
            rawResource: rawRef,
            rawTarget: rawRef,
            ...(params.targetNamespace ? { targetNamespace: params.targetNamespace } : {}),
          }),
        ),
      ).toBe(true);
      clearAdmissionSink();
      await writer.stop();
      return pageExecutionDecisionFactsForContext({
        context: token,
        limit: 1,
        now: now + 1,
        database,
      }).receipts[0]!;
    };

    const first = await write({ stateDir: firstStateDir, suffix: "first" });
    closeOpenClawStateDatabaseForTest();
    const restarted = await write({ stateDir: firstStateDir, suffix: "restart" });
    const sessionScoped = await write({
      stateDir: firstStateDir,
      suffix: "session",
      targetNamespace: "session",
    });
    closeOpenClawStateDatabaseForTest();
    const otherInstallation = await write({
      stateDir: tempDirs.make("openclaw-audit-private-other-installation-"),
      suffix: "other",
    });

    expect(restarted.action.resourceRef).toBe(first.action.resourceRef);
    expect(restarted.action.targetRef).toBe(first.action.targetRef);
    expect(first.action.resourceRef).not.toBe(first.action.targetRef);
    expect(sessionScoped.action.targetRef).not.toBe(first.action.targetRef);
    expect(otherInstallation.action.resourceRef).not.toBe(first.action.resourceRef);
    expect(otherInstallation.action.targetRef).not.toBe(first.action.targetRef);
  });
});
