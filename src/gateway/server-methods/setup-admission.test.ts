import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedSetupSession,
  runExclusiveSystemAgentSetupActivation,
  tryAcquireSetupAdmission,
} from "./setup-admission.js";

describe("setup admission", () => {
  it("rejects concurrent work instead of queueing it", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => events.push("second:start"));
    await expect(runExclusiveSystemAgentSetupActivation(secondTask)).rejects.toThrow(
      "setup is already in progress",
    );
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await runExclusiveSystemAgentSetupActivation(async () => events.push("third:start"));
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("releases the admission lease when work fails", async () => {
    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    await expect(runExclusiveSystemAgentSetupActivation(async () => "ok")).resolves.toBe("ok");
  });

  it("holds an admitted session lease until its runner settles", async () => {
    const release = tryAcquireSetupAdmission();
    expect(release).toBeDefined();
    const settled = createDeferred();
    createAdmittedSetupSession(release as () => void, () => ({
      whenSettled: () => settled.promise,
    }));

    expect(tryAcquireSetupAdmission()).toBeUndefined();
    settled.resolve();
    await settled.promise;
    await Promise.resolve();
    const nextRelease = tryAcquireSetupAdmission();
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
  });

  it("releases an admitted session lease when construction fails", () => {
    const release = tryAcquireSetupAdmission();
    expect(release).toBeDefined();
    expect(() =>
      createAdmittedSetupSession(release as () => void, () => {
        throw new Error("construction failed");
      }),
    ).toThrow("construction failed");
    const nextRelease = tryAcquireSetupAdmission();
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
  });
});
