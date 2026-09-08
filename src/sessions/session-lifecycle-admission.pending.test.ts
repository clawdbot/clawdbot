import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAgentRunDirectAbortError } from "../agents/run-termination.js";
import {
  beginSessionWorkAdmission,
  collectActiveSessionWorkAdmissions,
  getActiveSessionWorkAdmissionCount,
  getSessionWorkAdmissionRelease,
  interruptSessionWorkAdmissions,
  isCompetingSessionWorkAdmissionActive,
  isSessionWorkAdmissionActive,
  captureGatewaySessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

it("rejects arrivals during awaited cleanup and its final microtask, then reopens only after release", async () => {
  const scope = "hostile-await.sqlite";
  const identities = ["agent:main:fence", "fence-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const reason = createAgentRunDirectAbortError();
  let lateResult: unknown;
  const late = () =>
    beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} }).then(
      (lease) => {
        lease.release();
        return "incorrectly admitted";
      },
      (error: unknown) => error,
    );
  const stop = runExclusiveSessionLifecycleMutation({
    scope,
    identities,
    prepare: async (owner) => {
      owner.closeWorkAdmissions(reason);
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
    finalize: async () => {
      await Promise.resolve();
      lateResult = await late();
    },
  });
  await entered.promise;
  try {
    const whileAwaiting = await late();
    expect(whileAwaiting).toBe(reason);
    const other = await beginSessionWorkAdmission({
      scope,
      identities: ["other-session"],
      assertAllowed: () => {},
    });
    other.release();
    release.resolve();
    await stop;
    expect(lateResult).toBe(reason);
    const fresh = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
    fresh.release();
  } finally {
    release.resolve();
    await stop;
  }
});

it("interrupts a preexisting non-chat pending attempt without classifying it as active work", async () => {
  const scope = "non-chat-pending.sqlite";
  const resolveGatewayContext = () => undefined;
  const identities = ["agent:main:pending", "pending-session"] as const;
  const entered = createDeferred();
  const release = createDeferred();
  const interrupted = vi.fn();
  let validated = false;
  const blocker = runExclusiveSessionLifecycleMutation({
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    onInterrupt: interrupted,
    resolveGatewayContext,
    assertAllowed: () => {
      validated = true;
    },
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  try {
    expect(isSessionWorkAdmissionActive(scope, identities)).toBe(false);
    expect(
      captureGatewaySessionWorkAdmissions(resolveGatewayContext).isActive({
        scope,
        sessionKey: identities[0],
        sessionId: identities[1],
      }),
    ).toBe(false);
    expect(isCompetingSessionWorkAdmissionActive(scope, identities)).toBe(false);
    expect(getSessionWorkAdmissionRelease({ scope, identities })).toBeUndefined();
    expect(collectActiveSessionWorkAdmissions().get(scope)).toBeUndefined();
    expect(getActiveSessionWorkAdmissionCount()).toBe(0);
    const reason = createAgentRunDirectAbortError();
    expect(
      await interruptSessionWorkAdmissions({ scope, identities, reason, timeoutMs: 1000 }),
    ).toBe(true);
    expect(await pending).toBe(reason);
    expect(interrupted).toHaveBeenCalledOnce();
    expect(interrupted).toHaveBeenCalledWith(reason);
    expect(validated).toBe(false);
  } finally {
    release.resolve();
    await blocker;
    await pending;
  }
});

it("ordinary compaction still queues work and acquired-release queries do not deadlock it", async () => {
  const scope = "compaction.sqlite";
  const identities = ["compaction-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const compaction = runExclusiveSessionLifecycleMutation({
    scope,
    identities,
    kind: "compaction",
    prepare: async () => {
      entered.resolve();
      await release.promise;
      await getSessionWorkAdmissionRelease({ scope, identities });
    },
    run: async () => {},
  });
  await entered.promise;
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    expect(validated).toBe(false);
    release.resolve();
    await compaction;
    const lease = await pending;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await compaction;
    (await pending).release();
  }
});

it("single-use identity iterators still wait for the exact lifecycle fence", async () => {
  const scope = "generator.sqlite";
  const identities = ["generator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  let validated = false;
  const mutation = runExclusiveSessionLifecycleMutation({
    scope,
    identities,
    prepare: async () => {
      entered.resolve();
      await release.promise;
    },
    run: async () => {},
  });
  await entered.promise;
  const admission = beginSessionWorkAdmission({
    scope,
    identities: (function* () {
      yield identities[0];
    })(),
    assertAllowed: () => {
      validated = true;
    },
  });
  try {
    const unrelated = await beginSessionWorkAdmission({
      scope,
      identities: ["unrelated-generator"],
      assertAllowed: () => {},
    });
    unrelated.release();
    expect(validated).toBe(false);
    release.resolve();
    await mutation;
    const lease = await admission;
    expect(validated).toBe(true);
    lease.release();
  } finally {
    release.resolve();
    await mutation;
    (await admission).release();
  }
});

it("an initial validator finishing after pending cancellation cannot enter the writer", async () => {
  const scope = "initial-validator.sqlite";
  const identities = ["initial-validator-session"];
  const entered = createDeferred();
  const release = createDeferred();
  const writer = vi.fn();
  const reason = createAgentRunDirectAbortError();
  const pending = beginSessionWorkAdmission({
    scope,
    identities,
    assertAllowed: async () => {
      entered.resolve();
      await release.promise;
    },
    revalidateAllowed: writer,
  }).then(
    (lease) => {
      lease.release();
      return "incorrectly admitted";
    },
    (error: unknown) => error,
  );
  await entered.promise;
  try {
    expect(
      await interruptSessionWorkAdmissions({ scope, identities, reason, timeoutMs: 1000 }),
    ).toBe(true);
    expect(await pending).toBe(reason);
    release.resolve();
    // A later mutation must wait for the validator's existing identity lock to finish.
    await runExclusiveSessionLifecycleMutation({ scope, identities, run: async () => {} });
    expect(writer).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await pending;
  }
});
