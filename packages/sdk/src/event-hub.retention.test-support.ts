import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventHub } from "./event-hub.js";

type Mode = "return" | "filter-error" | "reentrant-return" | "hub-close";
type Payload = { kind: "backlog" | "trigger" };
type Held = {
  mode: Mode;
  hub: EventHub<Payload>;
  iterator: AsyncIterator<Payload>;
  refs: Array<{ kind: Payload["kind"]; value: WeakRef<Payload> }>;
};
const held: Held[] = [];
const report = {
  phase: "setup",
  gcPasses: 0,
  controlRetained: null as boolean | null,
  observations: [] as Array<{ mode: Mode; kind: Payload["kind"]; retained: boolean }>,
  hubCloseDrained: false,
  terminalBehavior: [] as Array<{ mode: Mode; outcome: "done" | "filter-error" }>,
  cleanupErrors: [] as string[],
  error: null as string | null,
  verdict: "incomplete",
};
const reason = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function publishWeak(hub: EventHub<Payload>, kind: Payload["kind"]) {
  // This activation owns the only temporary strong payload reference.
  const payload: Payload = { kind };
  const value = new WeakRef(payload);
  hub.publish(payload);
  return { kind, value };
}

async function prepare(mode: Mode) {
  const hub = new EventHub<Payload>();
  let returned: Promise<IteratorResult<Payload>> | undefined;
  const stream = hub.stream((event) => {
    if (event.kind === "trigger") {
      if (mode === "filter-error") {
        throw new Error("synthetic filter retirement");
      }
      if (mode === "reentrant-return") {
        returned = iterator.return?.();
      }
    }
    return true;
  });
  const iterator: AsyncIterator<Payload> = stream[Symbol.asyncIterator]();
  const item: Held = { mode, hub, iterator, refs: [] };
  held.push(item);
  item.refs.push(publishWeak(hub, "backlog"));
  if (mode === "return") {
    await iterator.return?.();
  } else if (mode === "hub-close") {
    hub.close();
  } else {
    item.refs.push(publishWeak(hub, "trigger"));
    if (mode === "reentrant-return") {
      assert.ok(returned, "The filter must actually return the entered iterator");
      await returned;
    }
  }
}

let failed = false;
let failure: unknown;
try {
  const gc = globalThis.gc;
  assert.ok(gc, "The retirement probe requires --expose-gc");
  const control = new WeakRef({ uncached: true });
  for (const mode of ["return", "filter-error", "reentrant-return", "hub-close"] as const) {
    await prepare(mode);
  }
  report.phase = "collect";
  // WeakRef construction keeps its target alive for the current job.
  await setImmediate();
  for (let pass = 0; pass < 8; pass++) {
    gc();
    await setImmediate();
    report.gcPasses++;
  }
  report.phase = "observe";
  report.controlRetained = control.deref() !== undefined;
  report.observations = held.flatMap(({ mode, refs }) =>
    refs.map(({ kind, value }) => ({ mode, kind, retained: value.deref() !== undefined })),
  );
  if (report.controlRetained) {
    report.verdict = "gc-inconclusive";
    throw new Error("Uncached control retained; no payload-retention conclusion");
  }
  report.phase = "verify-visible-contract";
  for (const { mode, iterator, refs } of held) {
    if (mode === "hub-close") {
      const expected = refs[0]?.value.deref();
      assert.ok(expected, "Hub close must retain its unread event for draining");
      const next = await iterator.next();
      assert.equal(next.done, false);
      assert.equal(next.value, expected);
      report.hubCloseDrained = true;
    }
    if (mode === "filter-error") {
      await assert.rejects(iterator.next(), /synthetic filter retirement/);
      report.terminalBehavior.push({ mode, outcome: "filter-error" });
    } else {
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
      report.terminalBehavior.push({ mode, outcome: "done" });
    }
  }
  report.phase = "verify-retirement";
  report.verdict = "retention-failed";
  const retainedRetired = report.observations.filter(
    ({ mode, retained }) => mode !== "hub-close" && retained,
  );
  assert.deepEqual(
    retainedRetired,
    [],
    "Retired iterators must release backlog and reentrant payloads",
  );
  report.verdict = "passed";
} catch (error) {
  failed = true;
  failure = error;
  report.error = reason(error);
} finally {
  for (const { hub, iterator } of held) {
    try {
      await iterator.return?.();
    } catch (error) {
      report.cleanupErrors.push(reason(error));
      failed = true;
      failure ??= error;
    } finally {
      hub.close();
    }
  }
  if (report.cleanupErrors.length > 0) {
    report.verdict = "cleanup-failed";
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if (failed) {
  throw failure;
}
