import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventStream } from "./event-stream.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const control = new WeakRef({ uncached: true });

async function consumeFirst(completed: boolean) {
  const stream = new EventStream<{ index: number }, { complete: boolean }>(
    () => false,
    () => {
      throw new Error("No terminal event is used by this fixture");
    },
  );
  const consumed = { index: 0 };
  const pending = { index: 1 };
  const final = { complete: true };
  stream.push(consumed);
  stream.push(pending);
  if (completed) {
    stream.end(final);
  }
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: consumed, done: false });
  await iterator.return?.();
  return {
    completed,
    stream,
    consumed: new WeakRef(consumed),
    pending: new WeakRef(pending),
    final: new WeakRef(final),
  };
}

const held = [await consumeFirst(false), await consumeFirst(true)];
// Dereferencing during collection would keep the target alive for that job.
for (let pass = 0; pass < 8; pass += 1) {
  gc();
  await setImmediate();
}
assert.equal(control.deref(), undefined, "The uncached GC control must be collected");
const observed = held.map(({ completed, consumed, final }) => ({
  completed,
  consumedRetained: consumed.deref() !== undefined,
  finalRetained: final.deref() !== undefined,
}));
for (const { stream, pending } of held) {
  assert.ok(pending.deref(), "The unread event remains owned by the stream");
  const iterator = stream[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: pending.deref(), done: false });
  await iterator.return?.();
  stream.end({ complete: true });
  assert.deepEqual(await stream.result(), { complete: true });
}
process.stdout.write(JSON.stringify(observed));
