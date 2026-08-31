import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
  type ExecutionIdentityAdmissionFacts,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "./execution-identity-context.js";
import { executionIdentitySpawnAdmission } from "./execution-identity-spawn-admission.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function facts(
  runId: string,
  overrides: Partial<ExecutionIdentityAdmissionFacts> & {
    spawnLineage?: Record<string, unknown>;
    spawnMissingEvidence?: string[];
  } = {},
): ExecutionIdentityAdmissionFacts {
  const { spawnLineage, spawnMissingEvidence, ...admissionOverrides } = overrides;
  return executionIdentitySpawnAdmission({
    operation: "attach",
    value: {
      runId,
      agentId: "main",
      ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
      runtime: { kind: "embedded" },
      ...admissionOverrides,
    },
    extra:
      spawnLineage || spawnMissingEvidence
        ? executionIdentitySpawnAdmission({
            operation: "serialize",
            value: spawnLineage,
            extra: spawnMissingEvidence ?? [],
          })
        : undefined,
  });
}

function prepareContext(
  admissionFacts: ExecutionIdentityAdmissionFacts,
  ids: { contextId: string; executionId: string; now?: number },
) {
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((captured) => {
    if (captured.kind === "capture") {
      envelope = captured.envelope;
    }
    return true;
  });
  try {
    enqueueExecutionIdentityContextAtAdmission(admissionFacts, {
      enabled: true,
      contextId: ids.contextId,
      executionId: ids.executionId,
      ...(ids.now !== undefined ? { now: ids.now } : {}),
    });
  } finally {
    clear();
  }
  if (!envelope) {
    throw new Error("expected admission envelope");
  }
  return processExecutionIdentityAdmissionWork(
    { kind: "capture", envelope },
    {
      env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-lineage-") },
      ...(ids.now !== undefined ? { now: ids.now } : {}),
    },
  );
}

describe("execution identity child lineage", () => {
  it("preserves private spawn facts across the prepared-admission copy", () => {
    const context = prepareContext(
      {
        ...facts("copied-child-run", {
          spawnLineage: {
            parentContextId: "copied-parent-context",
            parentExecutionId: "copied-parent-execution",
            parentRunId: "copied-parent-run",
            parentAgentId: "parent-agent",
            relation: "sessions_spawn",
            rawRequesterRef: "requester",
            rawControllerRef: "controller",
            depth: 1,
            localPolicyRefs: [],
            targetPolicyRefs: [],
          },
        }),
      },
      { contextId: "copied-child-context", executionId: "copied-child-execution", now: 100 },
    );

    expect(context.lineage).toMatchObject({
      parentContextId: "copied-parent-context",
      parentExecutionId: "copied-parent-execution",
      parentRunId: "copied-parent-run",
      depth: 1,
    });
  });

  it("projects bounded narrowing inputs without retaining raw owner refs", () => {
    const context = prepareContext(
      facts("child-run", {
        ingress: { kind: "subagent", boundary: "sessions_spawn.subagent", state: "present" },
        invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
        applicableGrants: [{ rawGrantRef: "tool:sessions_spawn", state: "present" }],
        assurance: [
          {
            kind: "spawn-lineage",
            rawEvidenceRef: "native-spawn-proof",
            strength: "boundary-verified",
          },
        ],
        spawnLineage: {
          parentContextId: "parent-context",
          parentExecutionId: "parent-execution",
          parentRunId: "parent-run",
          parentAgentId: "parent-agent",
          relation: "sessions_spawn",
          rawRequesterRef: "agent:main:private-requester",
          rawControllerRef: "agent:main:private-controller",
          depth: 2,
          localPolicyRefs: ["local-policy-secret"],
          targetPolicyRefs: ["target-policy-secret"],
        },
      }),
      { contextId: "child-context", executionId: "child-execution", now: 100 },
    );

    expect(context.coverageState).toBe("attribution-only");
    expect(context.lineage).toMatchObject({
      parentContextId: "parent-context",
      parentExecutionId: "parent-execution",
      parentRunId: "parent-run",
      parentAgentPrincipal: { kind: "agent", principalRef: "parent-agent" },
      depth: 2,
      delegationRef: expect.any(String),
    });
    expect(context.applicableGrants).toHaveLength(1);
    expect(context.assurance).toHaveLength(1);
    expect(context.missingEvidence).toEqual([]);
    expect(JSON.stringify(context)).not.toMatch(
      /private-requester|private-controller|local-policy-secret|target-policy-secret|native-spawn-proof|tool:sessions_spawn/,
    );
  });

  it("keeps attribution visible when parent evidence and ACP callbacks are unavailable", () => {
    const context = prepareContext(
      facts("acp-child", {
        ingress: { kind: "acp", boundary: "sessions_spawn.acp", state: "present" },
        invoker: { state: "present", kind: "agent", rawPrincipalRef: "parent-agent" },
        spawnLineage: {
          parentAgentId: "parent-agent",
          relation: "sessions_spawn",
          rawRequesterRef: "requester",
          rawControllerRef: "controller",
          depth: 1,
          localPolicyRefs: [],
          targetPolicyRefs: [],
        },
        spawnMissingEvidence: [
          "lineage.parent-context",
          "lineage.parent-execution",
          "lineage.parent-run",
          "acp.native-action-callback",
        ],
      }),
      { contextId: "acp-context", executionId: "acp-execution" },
    );

    expect(context.coverageState).toBe("attribution-only");
    expect(context.lineage).toMatchObject({ depth: 1 });
    expect(context.lineage).not.toHaveProperty("parentContextId");
    expect(context.missingEvidence).toEqual([
      "acp.native-action-callback",
      "lineage.parent-context",
      "lineage.parent-execution",
      "lineage.parent-run",
    ]);
  });
});
