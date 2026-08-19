import { describe, expect, it } from "vitest";
import {
  createSkillWorkshopRevisionAdmissions,
  type SkillWorkshopRevisionAdmissionInput,
} from "./skill-workshop-revision-admissions.ts";

const input = (instructions: string): SkillWorkshopRevisionAdmissionInput => ({
  expectedRevisionHash: "a".repeat(64),
  instructions,
  proposalAgentId: "main",
  proposalId: "proposal-main",
  proposalSlug: "main-inbox-cleaner",
  useCurrentChatForRevisions: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Skill Workshop revision admission owner", () => {
  it("removes only the exact ACK-admitted entry", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const first = deferred<{ sessionKey: string }>();
    const second = deferred<{ sessionKey: string }>();
    const runA = owner.start(input("first"), () => first.promise);
    const runB = owner.start(input("second"), () => second.promise);

    second.resolve({ sessionKey: "agent:main:second" });
    await expect(runB.completion).resolves.toEqual({
      id: runB.entry.id,
      sessionKey: "agent:main:second",
      status: "admitted",
    });

    expect(owner.get(runB.entry.id)).toBeNull();
    expect(owner.get(runA.entry.id)).toMatchObject({ instructions: "first", phase: "pending" });
  });

  it("retains failure and retries the same record and idempotency key", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const attempts: Array<ReturnType<typeof deferred<{ sessionKey: string }>>> = [];
    const idempotencyKeys: string[] = [];
    const run = owner.start(input("retry exactly"), (entry) => {
      idempotencyKeys.push(entry.idempotencyKey);
      const attempt = deferred<{ sessionKey: string }>();
      attempts.push(attempt);
      return attempt.promise;
    });
    attempts[0]!.reject(new Error("owner replaced"));
    await expect(run.completion).resolves.toMatchObject({ status: "retryable-failed" });

    expect(owner.firstFailed("main")).toMatchObject({
      expectedRevisionHash: "a".repeat(64),
      id: run.entry.id,
      instructions: "retry exactly",
      phase: "retryable-failed",
    });
    const retry = owner.retry(run.entry.id);
    expect(retry?.entry).toMatchObject({
      id: run.entry.id,
      idempotencyKey: run.entry.idempotencyKey,
      phase: "pending",
    });
    expect(idempotencyKeys).toEqual([run.entry.idempotencyKey, run.entry.idempotencyKey]);
    attempts[1]!.resolve({ sessionKey: "agent:main:retry" });
    await expect(retry?.completion).resolves.toMatchObject({ status: "admitted" });
    expect(owner.get(run.entry.id)).toBeNull();
  });

  it("keeps overlapping failures independent and reveals them in insertion order", async () => {
    const owner = createSkillWorkshopRevisionAdmissions();
    const first = deferred<{ sessionKey: string }>();
    const second = deferred<{ sessionKey: string }>();
    const runA = owner.start(input("first failed"), () => first.promise);
    const runB = owner.start(input("second failed"), () => second.promise);

    second.reject(new Error("second error"));
    first.reject(new Error("first error"));
    await Promise.all([runA.completion, runB.completion]);

    expect(owner.firstFailed("main")).toMatchObject({
      id: runA.entry.id,
      instructions: "first failed",
    });
    expect(owner.get(runB.entry.id)).toMatchObject({
      error: "second error",
      instructions: "second failed",
    });
  });
});
