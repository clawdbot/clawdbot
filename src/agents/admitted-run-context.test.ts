import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureExecutionIdentityAdmissionSink,
  createExecutionIdentityAdmissionToken,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import { validateAgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import {
  closeAdmittedRunDelegatedAuthority,
  createExecutionIdentityRecoveryAdmission,
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  retainAdmittedRunBeforeToolCallRecovery,
  resolveAdmittedRunActiveAssertion,
  resolvePreparedRunAdmission,
  type PreparedAgentRunAdmission,
} from "./admitted-run-context.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";

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
  it.each([false, true])(
    "owns real fixture authority across module resets and runner settlement (reject=%s)",
    async (reject) => {
      vi.resetModules();
      const admissionOwner = await import("./admitted-run-context.js");
      const failure = new Error("runner failed");
      let assertActive: (() => void) | undefined;
      const run = wrapRunWithTestPreparedAdmission(
        async (params: { runId: string; preparedRunAdmission: PreparedAgentRunAdmission }) => {
          const admitted = await params.preparedRunAdmission.admit("embedded");
          expect(await params.preparedRunAdmission.admit("plugin-harness")).toBe(admitted);
          expect(admitted).not.toHaveProperty("executionIdentityToken");
          assertActive = admissionOwner.resolveAdmittedRunActiveAssertion(admitted);
          expect(assertActive).toBeTypeOf("function");
          assertActive?.();
          if (reject) {
            throw failure;
          }
          return "done";
        },
      );
      const result = run({ runId: `runner-fixture-${reject}` });
      if (reject) {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toBe("done");
      }
      expect(() => assertActive?.()).toThrow("no longer active");
    },
  );

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

  it("adopts an original retry token only for its explicitly bound operational run", async () => {
    const token = createExecutionIdentityAdmissionToken("original-run");
    let work: ExecutionIdentityAdmissionWork | undefined;
    cleanupSink = configureExecutionIdentityAdmissionSink((candidate) => {
      work = candidate;
      return true;
    });
    const rejected = createExecutionIdentityRecoveryAdmission({
      retryOnly: true,
      token,
      expectedOperationalRunId: facts.runId,
    });

    expect(rejected.consume("other-operational-run")).toEqual({ accepted: false });
    expect(rejected.consume(facts.runId)).toEqual({ accepted: false });

    const { runtime, ...admissionFacts } = facts;
    const admitted = await prepareAgentRunAdmission({
      cfg: enabledConfig,
      facts: admissionFacts,
      operationalRunInstance: createOperationalRunInstanceRef(facts.runId),
      recovery: createExecutionIdentityRecoveryAdmission({
        retryOnly: true,
        token,
        expectedOperationalRunId: facts.runId,
      }),
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

  it("keeps one claim across fallback and never revives it after outer close", async () => {
    const { runtime, ...admissionFacts } = facts;
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: { ...admissionFacts, runId: "run-lease" },
      operationalRunInstance: createOperationalRunInstanceRef("run-lease"),
    });
    const admitted = await resolvePreparedRunAdmission({
      runId: "run-lease",
      runtimeKind: runtime.kind,
      preparedRunAdmission: prepared,
    });
    const first = getAdmittedRunDelegatedAuthority(admitted)!;
    expect(validateAgentRunDelegatedAuthority(first)).toBe(true);
    await expect(
      resolvePreparedRunAdmission({
        runId: "run-lease",
        runtimeKind: "plugin-harness",
        preparedRunAdmission: prepared,
      }),
    ).resolves.toBe(admitted);
    expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(first);
    prepared.close();
    expect(() => prepared.assertSourceCurrent()).not.toThrow();
    expect(validateAgentRunDelegatedAuthority(first)).toBe(false);
    expect(closeAdmittedRunDelegatedAuthority(admitted)).toBe(false);
    await expect(prepared.admit(runtime.kind)).rejects.toThrow("already closed");
  });

  it("invalidates an admitted-run assertion on abort and outer close", async () => {
    const { runtime, ...admissionFacts } = facts;
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: { ...admissionFacts, runId: "run-assertion" },
      operationalRunInstance: createOperationalRunInstanceRef("run-assertion"),
    });
    const admitted = await prepared.admit(runtime.kind);
    const abort = new AbortController();
    const assertActive = resolveAdmittedRunActiveAssertion(admitted, abort.signal);

    expect(assertActive).toBeDefined();
    expect(() => assertActive?.()).not.toThrow();
    abort.abort();
    expect(() => assertActive?.()).toThrow("no longer active");
    prepared.close();
    expect(() => assertActive?.()).toThrow("no longer active");
  });

  it("closes generic authority while keeping a recovery-only lease active", async () => {
    const { runtime, ...admissionFacts } = facts;
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: { ...admissionFacts, runId: "run-private-lease" },
      operationalRunInstance: createOperationalRunInstanceRef("run-private-lease"),
    });
    const admitted = await prepared.admit(runtime.kind);
    const authority = getAdmittedRunDelegatedAuthority(admitted);
    const recovery = retainAdmittedRunBeforeToolCallRecovery(admitted);

    expect(authority).toBeDefined();
    expect(recovery).toBeDefined();
    expect(closeAdmittedRunDelegatedAuthority(admitted)).toBe(true);
    expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
    expect(() => recovery?.assertActive()).not.toThrow();

    recovery?.release();
    expect(() => recovery?.assertActive()).toThrow("no longer active");
    recovery?.release();
  });

  it.each([false, true])(
    "keeps retained native policy fenced after foreground close (refusedRebind=%s)",
    async (refusedRebind) => {
      let current = true;
      const { runtime, ...admissionFacts } = facts;
      const source = prepareAgentRunAdmission({
        cfg: {},
        facts: { ...admissionFacts, runId: "native-source-lease" },
        operationalRunInstance: createOperationalRunInstanceRef("native-source-lease"),
        assertSourceCurrent: () => {
          if (!current) {
            throw new Error("source claim lost");
          }
        },
      });
      const prepared = withPostAdmissionExecutionOwnerBinding(source, () => {});
      const admitted = await prepared.admit(runtime.kind);
      const recovery = retainAdmittedRunBeforeToolCallRecovery(admitted);
      expect(recovery).toBeDefined();
      try {
        if (refusedRebind) {
          const refused = prepareAgentRunAdmission({
            cfg: {},
            facts: { ...admissionFacts, runId: "native-source-lease" },
            operationalRunInstance: admitted.operationalRunInstance,
            assertSourceCurrent: () => {},
          });
          try {
            await expect(refused.admit(runtime.kind)).rejects.toThrow("already bound");
          } finally {
            refused.close();
          }
          expect(() => recovery!.assertActive()).not.toThrow();
        }
        prepared.close();
        expect(() => prepared.assertSourceCurrent()).not.toThrow();
        expect(() => recovery!.assertActive()).not.toThrow();
        current = false;
        expect(() => recovery!.assertActive()).toThrow("source claim lost");
        current = true;
        expect(() => recovery!.assertActive()).toThrow(
          "source execution authority is no longer active",
        );
        expect(() => prepared.assertSourceCurrent()).toThrow(
          "source execution authority is no longer active",
        );
      } finally {
        recovery?.release();
        prepared.close();
      }
    },
  );

  it("closes admitted authority when the owner binding hook fails", async () => {
    const { runtime, ...admissionFacts } = facts;
    let authority: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: { ...admissionFacts, runId: "run-binding-failure" },
      operationalRunInstance: createOperationalRunInstanceRef("run-binding-failure"),
      onAdmitted: (context) => {
        authority = getAdmittedRunDelegatedAuthority(context);
        throw new Error("controller binding failed");
      },
    });

    await expect(prepared.admit(runtime.kind)).rejects.toThrow("controller binding failed");
    expect(authority).toBeDefined();
    expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
  });

  it("closes authority synchronously while an admission hook is pending", async () => {
    const { runtime, ...admissionFacts } = facts;
    let releaseHook: (() => void) | undefined;
    let authority: ReturnType<typeof getAdmittedRunDelegatedAuthority>;
    const hookPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });
    const prepared = prepareAgentRunAdmission({
      cfg: {},
      facts: { ...admissionFacts, runId: "run-close-during-binding" },
      operationalRunInstance: createOperationalRunInstanceRef("run-close-during-binding"),
      onAdmitted: async (context) => {
        authority = getAdmittedRunDelegatedAuthority(context);
        await hookPending;
      },
    });
    const admission = prepared.admit(runtime.kind);
    await vi.waitFor(() => expect(authority).toBeDefined());

    prepared.close();

    expect(validateAgentRunDelegatedAuthority(authority!)).toBe(false);
    releaseHook?.();
    await expect(admission).rejects.toThrow("closed during admission");
  });
});
