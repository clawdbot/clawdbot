// Tests lifecycle/work admission ordering across canonical keys and backing ids.
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { runExclusiveSessionStoreWrite } from "../config/sessions/store-writer.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  beginSessionWorkAdmission,
  cancelSessionWorkAdmissionHandoff,
  consumeSessionWorkAdmissionHandoff,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
  hasOnlySessionLifecycleMutationKindActive,
  interruptSessionWorkAdmissions,
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("counts one multi-identity admission once", async () => {
  const admission = await beginSessionWorkAdmission({
    scope: "store-count",
    identities: ["agent:main:child", "session-count"],
    assertAllowed: () => {},
  });
  try {
    expect(getActiveSessionWorkAdmissionCount()).toBe(1);
  } finally {
    admission.release();
  }
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
});

it("atomically hands admitted work across an interrupted RPC boundary", async () => {
  const scope = "store-rpc-handoff";
  const identities = ["agent:main:main", "session-rpc-handoff"];
  const admission = await beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {},
  });
  const handoffId = admission.createHandoff();
  const mutationStarted = createDeferred();
  let mutationRan = false;
  const mutation = runExclusiveSessionLifecycleMutation({
    scope,
    identities,
    prepare: async () => {
      mutationStarted.resolve();
      expect(await interruptSessionWorkAdmissions({ scope, identities, timeoutMs: 1_000 })).toBe(
        true,
      );
    },
    run: async () => {
      mutationRan = true;
    },
  });
  await mutationStarted.promise;
  let interrupted = false;
  const adopted = consumeSessionWorkAdmissionHandoff({
    handoffId,
    scope,
    identities,
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    expect(adopted).toBe(admission);
    expect(interrupted).toBe(true);
    expect(cancelSessionWorkAdmissionHandoff(handoffId)).toBe(false);
    expect(mutationRan).toBe(false);
  } finally {
    adopted?.release();
    admission.release();
    await mutation;
  }
  expect(mutationRan).toBe(true);
});

it("keeps an admission handoff bound to its original identities", async () => {
  const admission = await beginSessionWorkAdmission({
    scope: "store-bound-handoff",
    identities: ["agent:main:main", "session-bound-handoff"],
    assertAllowed: () => {},
  });
  const handoffId = admission.createHandoff();

  expect(
    consumeSessionWorkAdmissionHandoff({
      handoffId,
      scope: "store-bound-handoff",
      identities: ["agent:main:other", "session-bound-handoff"],
    }),
  ).toBeUndefined();
  expect(cancelSessionWorkAdmissionHandoff(handoffId)).toBe(true);
  expect(isSessionWorkAdmissionActive("store-bound-handoff", ["session-bound-handoff"])).toBe(
    false,
  );
});

it("counts one multi-identity lifecycle mutation once across module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-mutation-count-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-mutation-count-b",
  );
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = first.runExclusiveSessionLifecycleMutation({
    scope: "store-mutation-count",
    identities: ["agent:main:child", "session-mutation-count"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  try {
    expect(first.getActiveSessionLifecycleMutationCount()).toBe(1);
    expect(second.getActiveSessionLifecycleMutationCount()).toBe(1);
  } finally {
    releaseMutation.resolve();
    await mutation;
  }
  expect(second.getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("rejects an admission that resumes after suspension closes the async gap", async () => {
  resetGatewayWorkAdmission();
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;
  expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);

  const admission = beginSessionWorkAdmission({
    scope: "store-suspend-race",
    identities: ["session-suspend-race", "backing-suspend-race"],
    assertAllowed: () => {},
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  releaseMutation.resolve();
  await mutation;
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);

  await expect(admission).rejects.toMatchObject({ name: "GatewayDrainingError" });
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  suspension?.release();
  resetGatewayWorkAdmission();
});

it("lets an admitted root enter session work while suspension preparation refuses new roots", async () => {
  resetGatewayWorkAdmission();
  const continueRoot = createDeferred();
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  const active = root?.run(async () => {
    await continueRoot.promise;
    const admission = await beginSessionWorkAdmission({
      scope: "store-admitted-root",
      identities: ["session-admitted-root"],
      assertAllowed: () => {},
    });
    admission.release();
  });
  const suspension = tryBeginGatewaySuspendAdmission(() => {});

  try {
    continueRoot.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(
      beginSessionWorkAdmission({
        scope: "store-new-root",
        identities: ["session-new-root"],
        assertAllowed: () => {},
      }),
    ).rejects.toMatchObject({ name: "GatewayDrainingError" });
  } finally {
    suspension?.rollback();
    root?.release();
    resetGatewayWorkAdmission();
  }
});

it("registers active work before waiting for the store writer barrier", async () => {
  const storePath = "store-writer-barrier";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  let validationCount = 0;
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const admissionPromise = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:child", "session-writer-barrier"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
    },
  });
  await firstValidation.promise;
  await Promise.resolve();

  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-barrier"])).toBe(true);

  releaseWriter.resolve();
  const admission = await admissionPromise;
  try {
    expect(validationCount).toBe(2);
  } finally {
    admission.release();
    await writer;
  }
});

it("revalidates inline when admission begins inside the active store writer", async () => {
  const storePath = "store-writer-reentrant-admission";
  const order: string[] = [];
  const admission = await runExclusiveSessionStoreWrite(storePath, async () => {
    order.push("writer:start");
    const lease = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["session-writer-reentrant-admission"],
      assertAllowed: () => {
        order.push("validate");
      },
    });
    order.push("writer:end");
    return lease;
  });

  try {
    expect(order).toEqual(["writer:start", "validate", "validate", "writer:end"]);
    expect(isSessionWorkAdmissionActive(storePath, ["session-writer-reentrant-admission"])).toBe(
      true,
    );
  } finally {
    admission.release();
  }
});

it("runs one-time admission work only during writer-barrier revalidation", async () => {
  let initialChecks = 0;
  let finalChecks = 0;
  const admission = await beginSessionWorkAdmission({
    scope: "store-dedicated-revalidation",
    identities: ["session-dedicated-revalidation"],
    assertAllowed: () => {
      initialChecks += 1;
    },
    revalidateAllowed: () => {
      finalChecks += 1;
    },
  });

  try {
    expect(initialChecks).toBe(1);
    expect(finalChecks).toBe(1);
  } finally {
    admission.release();
  }
});

it("rejects and releases an admission invalidated by an earlier store writer", async () => {
  const storePath = "store-writer-revalidation";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  let allowed = true;
  let validationCount = 0;
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
    allowed = false;
  });
  await writerStarted.promise;

  const admission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:child", "session-writer-revalidation"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
      if (!allowed) {
        throw new Error("session changed");
      }
    },
  });
  await firstValidation.promise;
  await Promise.resolve();
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-revalidation"])).toBe(true);

  releaseWriter.resolve();
  await writer;
  await expect(admission).rejects.toThrow("session changed");
  expect(validationCount).toBe(2);
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-revalidation"])).toBe(false);
});

it("releases an admission aborted while waiting for the store writer barrier", async () => {
  const storePath = "store-writer-abort";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  const controller = new AbortController();
  const abortError = new Error("admission aborted behind writer");
  const writer = runExclusiveSessionStoreWrite(storePath, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;

  const admission = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["session-writer-abort"],
    signal: controller.signal,
    assertAllowed: () => {
      firstValidation.resolve();
    },
  });
  await firstValidation.promise;
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  expect(isSessionWorkAdmissionActive(storePath, ["session-writer-abort"])).toBe(false);

  releaseWriter.resolve();
  await writer;
});

it("revalidates without inheriting a released gateway root from the writer queue", async () => {
  resetGatewayWorkAdmission();
  const storePath = "store-released-gateway-root";
  const writerStarted = createDeferred();
  const releaseWriter = createDeferred();
  const firstValidation = createDeferred();
  const root = tryBeginGatewayRootWorkAdmission();
  expect(root).not.toBeNull();
  if (!root) {
    throw new Error("gateway root admission unavailable");
  }
  const writer = root.run(
    async () =>
      await runExclusiveSessionStoreWrite(storePath, async () => {
        writerStarted.resolve();
        await releaseWriter.promise;
      }),
  );
  await writerStarted.promise;

  let validationCount = 0;
  const admissionPromise = beginSessionWorkAdmission({
    scope: storePath,
    identities: ["session-released-gateway-root"],
    assertAllowed: () => {
      validationCount += 1;
      if (validationCount === 1) {
        firstValidation.resolve();
      }
    },
  });
  await firstValidation.promise;

  root.release();
  releaseWriter.resolve();
  const admission = await admissionPromise;
  try {
    expect(validationCount).toBe(2);
  } finally {
    admission.release();
    await writer;
    resetGatewayWorkAdmission();
  }
});

it("serializes lifecycle mutation and work admission across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  let admitted = false;
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    assertAllowed: () => {
      admitted = true;
    },
  });
  await Promise.resolve();
  expect(admitted).toBe(false);

  releaseMutation.resolve();
  await mutation;
  const admissionLease = await admission;
  expect(admitted).toBe(true);
  expect(isSessionWorkAdmissionActive("store-a", ["agent:main:child", "session-1"])).toBe(true);

  admissionLease.release();
  expect(isSessionWorkAdmissionActive("store-a", ["session-1"])).toBe(false);
});

it("tracks the active lifecycle mutation kind across identity aliases", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-kind",
    identities: ["agent:main:child", "session-kind"],
    kind: "compaction",
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(true);
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-other", ["session-kind"], "compaction"),
  ).toBe(false);

  releaseMutation.resolve();
  await mutation;
  expect(
    hasOnlySessionLifecycleMutationKindActive("store-kind", ["session-kind"], "compaction"),
  ).toBe(false);
});

it("keeps identical session keys isolated by store", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["global", "session-a"],
    assertAllowed: () => {},
  });

  try {
    expect(isSessionWorkAdmissionActive("store-a", ["global"])).toBe(true);
    expect(isSessionWorkAdmissionActive("store-b", ["global"])).toBe(false);
    let storeBMutationRan = false;
    await runExclusiveSessionLifecycleMutation({
      scope: "store-b",
      identities: ["global"],
      run: async () => {
        storeBMutationRan = true;
      },
    });
    expect(storeBMutationRan).toBe(true);
  } finally {
    admissionLease.release();
  }
});

it("cancels work admission waiting behind a lifecycle mutation", async () => {
  const mutationPrepared = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    prepare: async () => {
      mutationPrepared.resolve();
      await releaseMutation.promise;
    },
    run: async () => {},
  });
  await mutationPrepared.promise;

  const controller = new AbortController();
  const abortError = new Error("reset interrupted admission");
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    signal: controller.signal,
    assertAllowed: () => {},
  });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  releaseMutation.resolve();
  await mutation;
});

it("cancels work admission while a lifecycle mutation holds the identity lock", async () => {
  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  await mutationStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel during lifecycle mutation");
  const admission = beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["session-1"],
    signal: controller.signal,
    assertAllowed: () => {},
  });
  controller.abort(abortError);

  await expect(admission).rejects.toBe(abortError);
  releaseMutation.resolve();
  await mutation;
});

it("cancels a queued lifecycle mutation before it becomes active", async () => {
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel queued lifecycle mutation");
  let cancelledMutationRan = false;
  const cancelled = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    signal: controller.signal,
    run: async () => {
      cancelledMutationRan = true;
    },
  });
  controller.abort(abortError);

  await expect(cancelled).rejects.toBe(abortError);
  releaseFirst.resolve();
  await first;
  await runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {},
  });
  expect(cancelledMutationRan).toBe(false);
});

it("preserves the initiating admission across a queued lifecycle mutation", async () => {
  let selfInterrupted = false;
  const admission = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {
      selfInterrupted = true;
    },
  });
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  let initiatingAdmissionExcluded = false;
  const queued = admission.run(
    async () =>
      await runExclusiveSessionLifecycleMutation({
        scope: "store-a",
        identities: ["agent:main:child", "session-1"],
        prepare: async () => {
          initiatingAdmissionExcluded = await interruptSessionWorkAdmissions({
            scope: "store-a",
            identities: ["agent:main:child", "session-1"],
            timeoutMs: 1,
          });
        },
        run: async () => {},
      }),
  );

  try {
    releaseFirst.resolve();
    await first;
    await queued;
    expect(initiatingAdmissionExcluded).toBe(true);
    expect(selfInterrupted).toBe(false);
  } finally {
    releaseFirst.resolve();
    admission.release();
    await Promise.allSettled([first, queued]);
  }
});

it("bounds interruption waits for non-cooperative work", async () => {
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {},
  });

  try {
    await expect(
      interruptSessionWorkAdmissions({
        scope: "store-a",
        identities: ["session-1"],
        timeoutMs: 1,
      }),
    ).resolves.toBe(false);
  } finally {
    admissionLease.release();
  }
});

it("excludes the initiating admission from an in-band interruption", async () => {
  let interrupted = false;
  const admissionLease = await beginSessionWorkAdmission({
    scope: "store-a",
    identities: ["agent:main:child", "session-1"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
    },
  });

  try {
    await expect(
      admissionLease.run(
        async () =>
          await interruptSessionWorkAdmissions({
            scope: "store-a",
            identities: ["session-1"],
            timeoutMs: 1,
          }),
      ),
    ).resolves.toBe(true);
    expect(interrupted).toBe(false);
  } finally {
    admissionLease.release();
  }
});

it("shares lifecycle coordination across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=session-lifecycle-b",
  );
  let releaseLease = () => {};
  let interrupted = false;
  const lease = await first.beginSessionWorkAdmission({
    scope: "store-duplicate",
    identities: ["agent:main:child", "session-duplicate"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseLease();
    },
  });
  releaseLease = lease.release;

  try {
    expect(second.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      true,
    );
    await expect(
      second.interruptSessionWorkAdmissions({
        scope: "store-duplicate",
        identities: ["agent:main:child"],
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    expect(interrupted).toBe(true);
    expect(first.isSessionWorkAdmissionActive("store-duplicate", ["session-duplicate"])).toBe(
      false,
    );
  } finally {
    lease.release();
  }
});
