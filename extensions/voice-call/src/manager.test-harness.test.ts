import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { expect, it, onTestFinished } from "vitest";
import { createManagerHarness, markCallAnswered } from "./manager.test-harness.js";

it("finalizes each fixture's calls and destroys its real duration and transcript timers", async () => {
  const ownership = new AsyncLocalStorage<"duration" | "transcript">();
  const allocated = { duration: 0, transcript: 0 };
  const pending = new Map<number, "duration" | "transcript">();
  const observer = createHook({
    init(id, type) {
      const owner = ownership.getStore();
      if (type === "Timeout" && owner) {
        allocated[owner]++;
        pending.set(id, owner);
      }
    },
    destroy(id) {
      pending.delete(id);
    },
  }).enable();
  const fixtures: Array<Awaited<ReturnType<typeof createManagerHarness>>> = [];
  const callIds: string[] = [];
  const turns: Array<ReturnType<(typeof fixtures)[number]["manager"]["continueCall"]>> = [];
  let turnResult: Awaited<(typeof turns)[number]> | undefined;

  // Finish hooks are LIFO: register verification before allocating fixtures so
  // it observes their cleanup, after afterEach and fixture teardown have run.
  onTestFinished(async () => {
    try {
      await setImmediate(); // Node delivers timer destroy events on the next loop.
      expect(allocated).toEqual({ duration: 2, transcript: 1 });
      expect([...pending.values()], "fixture timers surviving test cleanup").toEqual([]);
      for (const [index, { manager, provider }] of fixtures.entries()) {
        expect(manager.getActiveCalls()).toEqual([]);
        expect(provider.hangupCalls).toEqual([]);
        expect(await manager.getCallFromMemoryOrStore(callIds[index]!)).toMatchObject({
          state: "hangup-user",
          endReason: "hangup-user",
          endedAt: expect.any(Number),
        });
      }
      expect(turnResult).toEqual({ success: false, error: "Call ended: hangup-user" });
    } finally {
      try {
        // Keep failing-before proof contained; this runs only after assertions
        // and uses carrier hangup, not the fixture's synthetic terminal event.
        for (const { manager } of fixtures) {
          for (const call of manager.getActiveCalls()) {
            await manager.endCall(call.callId);
          }
        }
        await Promise.all(turns);
      } finally {
        observer.disable();
        ownership.disable();
      }
    }
  });

  for (let index = 0; index < 2; index++) {
    const fixture = await createManagerHarness();
    fixtures.push(fixture);
    const started = await fixture.manager.initiateCall("+15550000001");
    expect(started.success).toBe(true);
    callIds.push(started.callId);
    ownership.run("duration", () => {
      markCallAnswered(fixture.manager, started.callId, `answered-${index}`);
    });
    if (index === 0) {
      turns.push(
        ownership.run("transcript", () =>
          fixture.manager.continueCall(started.callId, "Waiting for a reply").then((result) => {
            turnResult = result;
            return result;
          }),
        ),
      );
    }
  }
  await setImmediate();
  expect(allocated).toEqual({ duration: 2, transcript: 1 });
  expect(pending.size).toBe(3);
  expect(turnResult).toBeUndefined();
});
