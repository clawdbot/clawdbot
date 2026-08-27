// Covers queued lifecycle reservations that keep later work admissions behind mutations.
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getSessionWorkAdmissionRelease,
  runExclusiveSessionLifecycleMutation,
} from "./session-lifecycle-admission.js";

it("releases an aborted queued reservation without admitting past its predecessor", async () => {
  const target = { scope: "store-reserved-abort", identities: ["session-reserved-abort"] };
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const first = runExclusiveSessionLifecycleMutation({
    ...target,
    reserveAdmissionFenceWhileQueued: true,
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  });
  await firstStarted.promise;

  const controller = new AbortController();
  const abortError = new Error("cancel reserved mutation");
  let cancelledRan = false;
  const cancelled = runExclusiveSessionLifecycleMutation({
    ...target,
    reserveAdmissionFenceWhileQueued: true,
    signal: controller.signal,
    run: async () => {
      cancelledRan = true;
    },
  });
  let admissionRan = false;
  const admitted = beginSessionWorkAdmission({ ...target, assertAllowed: () => {} }).then(
    (admission) => {
      admissionRan = true;
      admission.release();
    },
  );

  controller.abort(abortError);
  await expect(cancelled).rejects.toBe(abortError);
  await waitForImmediate();
  expect(admissionRan).toBe(false);

  releaseFirst.resolve();
  await Promise.all([first, admitted]);
  expect(cancelledRan).toBe(false);
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("shares queued reservations and ordering across duplicate module instances", async () => {
  const first = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=queued-fence-a",
  );
  const second = await importFreshModule<typeof import("./session-lifecycle-admission.js")>(
    import.meta.url,
    "./session-lifecycle-admission.js?scope=queued-fence-b",
  );
  const target = { scope: "store-shared-reservation", identities: ["session-shared-reservation"] };
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  const order: string[] = [];
  const active = first.runExclusiveSessionLifecycleMutation({
    ...target,
    reserveAdmissionFenceWhileQueued: true,
    run: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first");
    },
  });
  await firstStarted.promise;
  const queued = second.runExclusiveSessionLifecycleMutation({
    ...target,
    reserveAdmissionFenceWhileQueued: true,
    run: async () => {
      order.push("second");
    },
  });
  const admitted = first
    .beginSessionWorkAdmission({ ...target, assertAllowed: () => {} })
    .then((admission) => {
      order.push("admission");
      admission.release();
    });

  expect(first.getActiveSessionLifecycleMutationCount()).toBe(2);
  expect(second.getActiveSessionLifecycleMutationCount()).toBe(2);
  releaseFirst.resolve();
  await Promise.all([active, queued, admitted]);
  expect(order).toEqual(["first", "second", "admission"]);
  expect(first.getActiveSessionLifecycleMutationCount()).toBe(0);
  expect(second.getActiveSessionLifecycleMutationCount()).toBe(0);
});

it("lets an earlier validating admission finish while fencing the later one", async () => {
  const target = { scope: "store-reservation-validation", identities: ["session-validation"] };
  const validationStarted = createDeferred();
  const releaseValidation = createDeferred();
  const order: string[] = [];
  const firstAdmission = beginSessionWorkAdmission({
    ...target,
    assertAllowed: async () => {
      validationStarted.resolve();
      await releaseValidation.promise;
    },
  }).then((admission) => {
    order.push("first-admission");
    return admission;
  });
  await validationStarted.promise;

  const mutationStarted = createDeferred();
  const releaseMutation = createDeferred();
  const mutation = runExclusiveSessionLifecycleMutation({
    ...target,
    reserveAdmissionFenceWhileQueued: true,
    prepare: async () => {
      await getSessionWorkAdmissionRelease(target);
    },
    run: async () => {
      order.push("mutation");
      mutationStarted.resolve();
      await releaseMutation.promise;
    },
  });
  const laterAdmission = beginSessionWorkAdmission({ ...target, assertAllowed: () => {} }).then(
    (admission) => {
      order.push("later-admission");
      admission.release();
    },
  );

  releaseValidation.resolve();
  const firstLease = await firstAdmission;
  await waitForImmediate();
  expect(order).toEqual(["first-admission"]);
  firstLease.release();

  await mutationStarted.promise;
  expect(order).toEqual(["first-admission", "mutation"]);
  releaseMutation.resolve();
  await Promise.all([mutation, laterAdmission]);
  expect(order).toEqual(["first-admission", "mutation", "later-admission"]);
});
