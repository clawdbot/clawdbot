import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import {
  createExecutionIdentityRecoveryAdmission,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";

const enabledConfig = { logging: { audit: { enabled: true, executionIdentity: true } } };
const facts = {
  runId: "run-1",
  agentId: "main",
  ingress: { kind: "system" as const, boundary: "test", state: "present" as const },
  runtime: { kind: "embedded" as const },
};

let cleanupSink: (() => void) | undefined;
afterEach(() => {
  cleanupSink?.();
  cleanupSink = undefined;
  vi.restoreAllMocks();
});

describe("prepared run admission", () => {
  it("creates distinct operational instances without identity while disabled", async () => {
    const { runtime, ...admissionFacts } = facts;
    const first = await prepareAgentRunAdmission({
      cfg: {},
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
    }).admit(runtime.kind);
    const second = await prepareAgentRunAdmission({
      cfg: {},
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
    }).admit(runtime.kind);

    expect(first.operationalRunInstance.runId).toBe(facts.runId);
    expect(second.operationalRunInstance.instanceId).not.toBe(
      first.operationalRunInstance.instanceId,
    );
    expect(first).not.toHaveProperty("executionIdentityToken");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operationalRunInstance)).toBe(true);
  });

  it("consumes disabled recovery evidence so a reused run id cannot inherit it", async () => {
    const token = createExecutionIdentityAdmissionToken(facts.runId);
    const recovery = createExecutionIdentityRecoveryAdmission({ retryOnly: true, token });
    const { runtime, ...admissionFacts } = facts;

    const disabled = await prepareAgentRunAdmission({
      cfg: {},
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery,
    }).admit(runtime.kind);
    const laterEnabled = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery,
    }).admit(runtime.kind);

    expect(disabled).not.toHaveProperty("executionIdentityToken");
    expect(laterEnabled).not.toHaveProperty("executionIdentityToken");
  });

  it("captures and carries the same enabled token object", async () => {
    let work: ExecutionIdentityAdmissionWork | undefined;
    cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
      work = candidate;
      return true;
    });

    const { runtime, ...admissionFacts } = facts;
    const admitted = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
    }).admit(runtime.kind);

    expect(admitted.executionIdentityToken).toBeDefined();
    expect(work?.kind).toBe("capture");
    if (work?.kind === "capture") {
      expect(work.envelope.contextId).toBe(admitted.executionIdentityToken?.contextId);
      expect(work.envelope.executionId).toBe(admitted.executionIdentityToken?.executionId);
    }
  });

  it("adopts only the exact saved retry token", async () => {
    const token = createExecutionIdentityAdmissionToken(facts.runId);
    let work: ExecutionIdentityAdmissionWork | undefined;
    cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
      work = candidate;
      return true;
    });

    const { runtime, ...admissionFacts } = facts;
    const admitted = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: createExecutionIdentityRecoveryAdmission({ retryOnly: true, token }),
    }).admit(runtime.kind);

    expect(admitted.executionIdentityToken).toBe(token);
    expect(work).toEqual({ kind: "retry-reference", token });
  });

  it("keeps missing or mismatched recovery identity unbound", async () => {
    const sink = vi.fn((_work: ExecutionIdentityAdmissionWork) => true);
    cleanupSink = configureExecutionIdentityAdmissionSink(sink);
    const { runtime, ...admissionFacts } = facts;
    const missing = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: createExecutionIdentityRecoveryAdmission({ retryOnly: true }),
    }).admit(runtime.kind);
    const mismatch = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: createExecutionIdentityRecoveryAdmission({
        retryOnly: true,
        token: createExecutionIdentityAdmissionToken("different-run"),
      }),
    }).admit(runtime.kind);
    const unauthorizedClone = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: {
        retryOnly: false,
        token: { ...createExecutionIdentityAdmissionToken(facts.runId) },
      } as never,
    }).admit(runtime.kind);

    expect(missing).not.toHaveProperty("executionIdentityToken");
    expect(mismatch).not.toHaveProperty("executionIdentityToken");
    expect(unauthorizedClone).not.toHaveProperty("executionIdentityToken");
    expect(sink).not.toHaveBeenCalled();
  });

  it("allocates once and reuses the first runtime admission across fallback", async () => {
    const sink = vi.fn((_work: ExecutionIdentityAdmissionWork) => true);
    cleanupSink = configureExecutionIdentityAdmissionSink(sink);
    const { runtime: _runtime, ...admissionFacts } = facts;
    const prepared = prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: createExecutionIdentityRecoveryAdmission({ retryOnly: false }),
    });

    const [first, fallback] = await Promise.all([
      prepared.admit("plugin-harness", "plugin-instance-1"),
      prepared.admit("worker", "worker-instance-1"),
    ]);
    const retry = await prepared.admit("embedded");

    expect(first).toBe(fallback);
    expect(first).toBe(retry);
    expect(first.executionIdentityToken).toBeDefined();
    expect(sink).toHaveBeenCalledTimes(1);
    const work = sink.mock.calls[0]?.[0] as ExecutionIdentityAdmissionWork | undefined;
    expect(work?.kind).toBe("capture");
    if (work?.kind === "capture") {
      expect(work.envelope.runtime).toEqual({ kind: "plugin-harness" });
      expect(work.envelope.runtimeInstanceId).toBe("plugin-instance-1");
    }
  });
});
