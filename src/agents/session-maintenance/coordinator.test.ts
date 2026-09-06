import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  beginForegroundSessionMaintenance,
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "./coordinator.js";

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
});

describe("session maintenance ownership", () => {
  it("aborts optional work before admitting foreground and waits for its actual cleanup", async () => {
    const started = createDeferred();
    const aborted = createDeferred();
    const cleanupStarted = createDeferred();
    const finishCleanup = createDeferred();
    const events: string[] = [];
    const owner = createSessionMaintenanceOwner({
      sessionKey: "session:cancel",
      preemptible: true,
    });
    owner.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    const work = owner.track(
      owner.run(async () => {
        started.resolve();
        try {
          await aborted.promise;
          owner.assertCurrent();
        } finally {
          events.push("cleanup started");
          cleanupStarted.resolve();
          await finishCleanup.promise;
          events.push("cleanup finished");
        }
      }),
    );
    const rejection = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;

    const admission = beginForegroundSessionMaintenance("session:cancel").then((release) => {
      events.push("foreground admitted");
      return release;
    });
    try {
      await cleanupStarted.promise;
      expect(owner.signal.aborted).toBe(true);
      expect(events).toEqual(["cleanup started"]);
    } finally {
      finishCleanup.resolve();
      (await admission)();
      await rejection;
    }
    expect(events).toEqual(["cleanup started", "cleanup finished", "foreground admitted"]);
    await owner.done;
  });

  it("keeps optional work pending until every foreground reservation releases without blocking reads", async () => {
    const releaseFirst = await beginForegroundSessionMaintenance("session:pending");
    const releaseSecond = await beginForegroundSessionMaintenance("session:pending");
    const owner = createSessionMaintenanceOwner({
      sessionKey: "session:pending",
      preemptible: true,
    });
    let ran = false;
    const work = owner.track(
      owner.run(async () => {
        owner.assertCurrent();
        ran = true;
      }),
    );
    try {
      await waitForSessionMaintenance("session:pending");
      expect(ran).toBe(false);

      releaseFirst();
      releaseFirst();
      await waitForSessionMaintenance("session:pending");
      expect(ran).toBe(false);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await work;
    }
    expect(ran).toBe(true);
  });

  it("admits another session while non-preemptible maintenance keeps its own session waiting", async () => {
    const started = createDeferred();
    const finish = createDeferred();
    const owner = createSessionMaintenanceOwner({ sessionKey: "session:busy" });
    const work = owner.track(
      owner.run(async () => {
        started.resolve();
        await finish.promise;
      }),
    );
    await started.promise;
    let busyAdmitted = false;
    const busyAdmission = beginForegroundSessionMaintenance("session:busy").then((release) => {
      busyAdmitted = true;
      return release;
    });
    try {
      const releaseOther = await beginForegroundSessionMaintenance("session:other");
      releaseOther();
      await waitForSessionMaintenance("session:other");
      expect(busyAdmitted).toBe(false);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      finish.resolve();
      await work;
      (await busyAdmission)();
    }
    expect(busyAdmitted).toBe(true);
  });

  it("allows nested maintenance reads to exclude their own active ancestors", async () => {
    const outer = createSessionMaintenanceOwner({ sessionKey: "session:nested" });
    const events: string[] = [];
    await outer.track(
      outer.run(async () => {
        const inner = createSessionMaintenanceOwner({ sessionKey: "session:nested" });
        await inner.track(
          inner.run(async () => {
            await waitForSessionMaintenance("session:nested");
            inner.assertCurrent();
            outer.assertCurrent();
            events.push("nested read completed");
          }),
        );
        await waitForSessionMaintenance("session:nested");
        events.push("outer read completed");
      }),
    );
    expect(events).toEqual(["nested read completed", "outer read completed"]);
    await waitForSessionMaintenance("session:nested");
  });

  it.each([true, false])(
    "serializes independent siblings and lets the older owner read with preemptible=%s",
    async (preemptible) => {
      const sessionKey = `session:siblings:${preemptible}`;
      const started = createDeferred();
      const allowRead = createDeferred();
      const readCompleted = createDeferred();
      const finishOlder = createDeferred();
      const stop = createDeferred();
      const events: string[] = [];
      const older = createSessionMaintenanceOwner({ sessionKey, preemptible });
      const olderWork = older.track(
        older.run(async () => {
          events.push("older started");
          started.resolve();
          await allowRead.promise;
          await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
          events.push("older read completed");
          readCompleted.resolve();
          await finishOlder.promise;
          events.push("older finished");
        }),
      );
      await started.promise;
      const younger = createSessionMaintenanceOwner({ sessionKey, preemptible: !preemptible });
      const youngerWork = younger.track(
        younger.run(async () => {
          events.push("younger started");
          await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
          events.push("younger read completed");
        }),
      );
      try {
        expect(events).toEqual(["older started"]);
        allowRead.resolve();
        await readCompleted.promise;
        expect(events).toEqual(["older started", "older read completed"]);
        finishOlder.resolve();
        await Promise.all([olderWork, youngerWork]);
        expect(events).toEqual([
          "older started",
          "older read completed",
          "older finished",
          "younger started",
          "younger read completed",
        ]);
      } finally {
        // Unblock fixture reads after an ordering failure so real owner cleanup still runs.
        stop.resolve();
        allowRead.resolve();
        finishOlder.resolve();
        await Promise.allSettled([olderWork, youngerWork]);
      }
    },
  );

  it.each(
    (["external dependent", "nested independent", "released parent"] as const).flatMap(
      (placement) => (["read", "foreground"] as const).map((action) => ({ placement, action })),
    ),
  )("orders child $action with $placement sibling", async ({ placement, action }) => {
    const sessionKey = `session:combined:${placement}:${action}`;
    const parentStarted = createDeferred();
    const allowChild = createDeferred();
    const childCreated = createDeferred();
    const childCompleted = createDeferred();
    const siblingStarted = createDeferred();
    const finishSibling = createDeferred();
    const finishParent = createDeferred();
    const events: string[] = [];
    const parent = createSessionMaintenanceOwner({ sessionKey });
    let child: ReturnType<typeof createSessionMaintenanceOwner> | undefined;
    let childWork: Promise<void> = Promise.resolve();
    let siblingWork: Promise<void> = Promise.resolve();
    const startSibling = () => {
      const sibling = createSessionMaintenanceOwner({ sessionKey });
      siblingWork = sibling.track(
        sibling.run(async () => {
          events.push("sibling started");
          siblingStarted.resolve();
          await finishSibling.promise;
          events.push("sibling completed");
        }),
      );
    };
    const parentWork = parent.track(
      parent.run(async () => {
        events.push("parent started");
        parentStarted.resolve();
        await allowChild.promise;
        if (placement === "nested independent") {
          startSibling();
          await siblingStarted.promise;
        } else if (placement === "released parent") {
          parent.releaseWrites();
          await siblingStarted.promise;
        }
        child = createSessionMaintenanceOwner({ sessionKey });
        childWork = child.track(
          child.run(async () => {
            events.push("child started");
            if (action === "read") {
              await waitForSessionMaintenance(sessionKey);
            } else {
              const release = await beginForegroundSessionMaintenance(sessionKey);
              release();
            }
            events.push("child completed");
            childCompleted.resolve();
          }),
        );
        childCreated.resolve();
        await childWork;
        events.push("parent resumed");
        await finishParent.promise;
        events.push("parent completed");
      }),
    );
    try {
      await parentStarted.promise;
      if (placement !== "nested independent") {
        startSibling();
      }
      allowChild.resolve();
      await childCreated.promise;
      // These owner waits have no I/O: drain the scheduled continuations without
      // relying on a test timeout to discover a circular dependency.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      if (placement === "external dependent") {
        expect([...events]).toEqual([
          "parent started",
          "child started",
          "child completed",
          "parent resumed",
        ]);
      } else {
        expect([...events]).toEqual(["parent started", "sibling started"]);
        finishSibling.resolve();
        await childCompleted.promise;
      }
      finishParent.resolve();
      await parentWork;
      await siblingStarted.promise;
      finishSibling.resolve();
      await siblingWork;
      const ordered =
        placement === "external dependent"
          ? ["child completed", "parent completed", "sibling started"]
          : ["sibling completed", "child started", "parent completed"];
      expect(events.filter((event) => ordered.includes(event))).toEqual(ordered);
    } finally {
      // Break a failed fixture's dependency cycle only after its ordering assertion;
      // actual tracked completion still settles every owner before teardown.
      allowChild.resolve();
      finishParent.resolve();
      finishSibling.resolve();
      parent.releaseWrites();
      child?.releaseWrites();
      await Promise.allSettled([parentWork, siblingWork, childWork]);
    }
    await waitForSessionMaintenance(sessionKey);
  });

  it("releases writes after disposal while retaining completion ownership of an external rerun", async () => {
    const sessionKey = "session:external-rerun";
    const disposing = createDeferred();
    const finishDisposal = createDeferred();
    const childRead = createDeferred();
    const finishChild = createDeferred();
    const stop = createDeferred();
    const events: string[] = [];
    const parent = createSessionMaintenanceOwner({ sessionKey });
    let childWork: Promise<void> = Promise.resolve();
    const parentWork = parent.track(
      parent.run(async () => {
        events.push("parent disposing");
        disposing.resolve();
        await finishDisposal.promise;
        parent.releaseWrites();
        expect(parent.assertCurrent).toThrow();
        events.push("parent writes released");
        await childWork;
        events.push("parent completed");
      }),
    );
    await disposing.promise;
    const child = createSessionMaintenanceOwner({ sessionKey });
    childWork = child.track(
      child.run(async () => {
        events.push("child started");
        await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
        events.push("child read completed");
        childRead.resolve();
        await finishChild.promise;
        events.push("child completed");
      }),
    );
    let parentDone = false;
    void parent.done.then(() => {
      parentDone = true;
    });
    try {
      expect(events).toEqual(["parent disposing"]);
      finishDisposal.resolve();
      await childRead.promise;
      expect(events).toEqual([
        "parent disposing",
        "parent writes released",
        "child started",
        "child read completed",
      ]);
      expect(parentDone).toBe(false);
      finishChild.resolve();
      await Promise.all([parentWork, childWork, parent.done]);
      expect(events.slice(-2)).toEqual(["child completed", "parent completed"]);
      expect(parentDone).toBe(true);
    } finally {
      stop.resolve();
      finishDisposal.resolve();
      finishChild.resolve();
      await Promise.allSettled([parentWork, childWork]);
    }
  });

  it.each(["fulfilled", "rejected"] as const)(
    "fences a retained assertion after tracked work is %s",
    async (outcome) => {
      const owner = createSessionMaintenanceOwner({ sessionKey: `session:settled:${outcome}` });
      const assertCurrent = owner.assertCurrent;
      const completion = createDeferred<string>();
      const work = owner.track(completion.promise);
      expect(assertCurrent).not.toThrow();
      if (outcome === "fulfilled") {
        completion.resolve("completed");
        await expect(work).resolves.toBe("completed");
      } else {
        const error = new Error("maintenance failed");
        const rejection = expect(work).rejects.toBe(error);
        completion.reject(error);
        await rejection;
      }

      await owner.done;
      expect(assertCurrent).toThrow();
      await waitForSessionMaintenance(`session:settled:${outcome}`);
    },
  );

  it.each(["close", "restart"] as const)(
    "aborts active maintenance and fences retained authority on process %s",
    async (event) => {
      const finish = createDeferred();
      const owner = createSessionMaintenanceOwner({ sessionKey: `session:lifecycle:${event}` });
      const assertCurrent = owner.assertCurrent;
      const work = owner.track(finish.promise);
      const rotation = drainGlobalSingletonLifecycleState(event);
      try {
        expect(owner.signal.aborted).toBe(true);
        expect(assertCurrent).toThrow();
      } finally {
        finish.resolve();
        await Promise.all([work, rotation]);
      }
      const successor = createSessionMaintenanceOwner({ sessionKey: `session:lifecycle:${event}` });
      await successor.track(
        successor.run(async () => {
          successor.assertCurrent();
        }),
      );
      expect(assertCurrent).toThrow();
    },
  );
});
