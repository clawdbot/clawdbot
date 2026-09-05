import * as nativeTimers from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

type TimerKind = "setTimeout" | "setInterval";
type Cancellation = "close" | "object" | "number" | "string" | "dispose";
type TimerMode = "native" | "owned";

function stringTimerId(handle: NodeJS.Timeout) {
  // oxlint-disable-next-line typescript/no-base-to-string -- Node Timeout stringifies via Symbol.toPrimitive.
  return String(handle);
}

function createTimerFixture() {
  const instance = new PluginInstance("timer-cancellation");
  const handles = new Set<NodeJS.Timeout>();
  return {
    timers: instance.globals,
    schedule(kind: TimerKind, callback: () => void, timeout = 1, mode: TimerMode = "owned") {
      const handle =
        mode === "owned"
          ? instance.globals[kind](callback, timeout)
          : kind === "setTimeout"
            ? nativeTimers.setTimeout(callback, timeout)
            : nativeTimers.setInterval(callback, timeout);
      handles.add(handle);
      return handle;
    },
    async dispose() {
      try {
        await instance.dispose();
      } finally {
        for (const handle of handles) {
          nativeTimers.clearTimeout(handle);
        }
      }
    },
  };
}

const cancellations: Cancellation[] = ["close", "object", "number", "string", "dispose"];
const timerKinds: TimerKind[] = ["setTimeout", "setInterval"];
const modes: TimerMode[] = ["native", "owned"];

describe("native timer cancellation ownership", () => {
  it.each(
    ([...timerKinds, "setImmediate"] as const).flatMap((kind) =>
      [
        { label: "null", value: null },
        { label: "object", value: {} },
      ].map(({ label, value }) => ({ kind, label, value })),
    ),
  )("$kind rejects a $label callback before scheduling", async ({ kind, value }) => {
    const fixture = createTimerFixture();
    try {
      for (const timers of [nativeTimers, fixture.timers]) {
        expect(() => Reflect.apply(timers[kind], undefined, [value, 60_000])).toThrowError(
          expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
        );
      }
    } finally {
      await fixture.dispose();
    }
  });

  it.each(timerKinds.flatMap((kind) => cancellations.map((method) => ({ kind, method }))))(
    "$kind releases canceled ownership through $method without retiring its sibling",
    async ({ kind, method }) => {
      const fixture = createTimerFixture();
      let calls = 0;
      const handle = fixture.schedule(kind, () => {
        calls += 1;
      });
      let siblingCalls = 0;
      const sibling = fixture.schedule("setInterval", () => {
        siblingCalls += 1;
      });
      const clear =
        kind === "setTimeout" ? fixture.timers.clearTimeout : fixture.timers.clearInterval;
      try {
        if (method === "close") {
          expect(handle.close()).toBe(handle);
        } else if (method === "dispose") {
          expect(handle[Symbol.dispose]()).toBeUndefined();
        } else {
          const target =
            method === "number"
              ? Number(handle)
              : method === "string"
                ? stringTimerId(handle)
                : handle;
          expect(clear(target)).toBeUndefined();
        }
        expect(handle.refresh()).toBe(handle);
        expect(handle.close()).toBe(handle);
        await delay(5);
        expect(calls).toBe(0);
        expect(siblingCalls).toBeGreaterThan(0);
        fixture.timers.clearInterval(sibling);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(["clearImmediate", "dispose"])(
    "Immediate releases ownership through %s",
    async (method) => {
      const fixture = createTimerFixture();
      let calls = 0;
      const handle = fixture.timers.setImmediate(() => {
        calls += 1;
      });
      try {
        if (method === "clearImmediate") {
          expect(fixture.timers.clearImmediate(handle)).toBeUndefined();
        } else {
          expect(handle[Symbol.dispose]()).toBeUndefined();
        }
        await delay(5);
        expect(calls).toBe(0);
      } finally {
        nativeTimers.clearImmediate(handle);
        await fixture.dispose();
      }
    },
  );

  it.each(timerKinds)("%s keeps exact native string-ID semantics", async (kind) => {
    const fixture = createTimerFixture();
    let calls = 0;
    const handle = fixture.schedule(kind, () => {
      calls += 1;
    });
    const clear =
      kind === "setTimeout" ? fixture.timers.clearTimeout : fixture.timers.clearInterval;
    try {
      const id = stringTimerId(handle);
      clear(`0${id}`);
      await delay(5);
      expect(calls).toBeGreaterThan(0);
      clear(handle);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(modes)(
    "%s allows first primitive cancellation after natural firing and refresh",
    async (mode) => {
      const fixture = createTimerFixture();
      let calls = 0;
      const handle = fixture.schedule(
        "setTimeout",
        () => {
          calls += 1;
        },
        1,
        mode,
      );
      const clear = mode === "owned" ? fixture.timers.clearTimeout : nativeTimers.clearTimeout;
      try {
        await delay(5);
        expect(calls).toBe(1);
        expect(handle.refresh()).toBe(handle);
        clear(Number(handle));
        await delay(5);
        expect(calls).toBe(1);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it.each(modes)("%s preserves stale primitive no-ops after natural rearm", async (mode) => {
    const fixture = createTimerFixture();
    let calls = 0;
    const handle = fixture.schedule(
      "setTimeout",
      () => {
        calls += 1;
      },
      1,
      mode,
    );
    const clear = mode === "owned" ? fixture.timers.clearTimeout : nativeTimers.clearTimeout;
    try {
      const originalId = Number(handle);
      await delay(5);
      expect(calls).toBe(1);
      expect(handle.refresh()).toBe(handle);
      const refreshedId = Number(handle);
      expect(refreshedId).not.toBe(originalId);
      clear(originalId);
      clear(refreshedId);
      await delay(5);
      expect(calls).toBe(2);
    } finally {
      await fixture.dispose();
    }
  });

  it.each(modes)(
    "%s preserves valid ID cancellation when refreshed inside its callback",
    async (mode) => {
      const fixture = createTimerFixture();
      let callbackError: unknown;
      const clear = mode === "owned" ? fixture.timers.clearTimeout : nativeTimers.clearTimeout;
      let calls = 0;
      const handle: NodeJS.Timeout = fixture.schedule(
        "setTimeout",
        function (this: unknown) {
          calls += 1;
          try {
            expect(this).toBe(handle);
            expect(handle.refresh()).toBe(handle);
            clear(id);
          } catch (error) {
            callbackError = error;
          }
        },
        1,
        mode,
      );
      const id = Number(handle);
      try {
        await delay(5);
        expect(callbackError).toBeUndefined();
        expect(calls).toBe(1);
      } finally {
        await fixture.dispose();
      }
    },
  );
});
