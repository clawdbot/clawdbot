import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { listSessionsFromStoreAsync } from "./session-utils-list.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const retired: WeakRef<SessionEntry>[] = [];
const control = new WeakRef<SessionEntry>({ sessionId: "uncached", updatedAt: 1 });
const cfg = {};
setRuntimeConfigSnapshot(cfg);
setActivePluginRegistry(createEmptyPluginRegistry());
const parentKey = "agent:main:parent";
const childKey = "agent:main:child";

async function populate() {
  const now = Date.now();
  const parent: SessionEntry = { sessionId: "parent", updatedAt: now };
  const child: SessionEntry = {
    sessionId: "child",
    updatedAt: now - 1,
    parentSessionKey: parentKey,
  };
  retired.push(new WeakRef(parent), new WeakRef(child));
  return listSessionsFromStoreAsync({
    cfg,
    storePath: "retired",
    store: { [parentKey]: parent, [childKey]: child },
    modelCatalog: [],
    opts: { limit: 1 },
  });
}

// A caller may keep the projected response after releasing its input snapshot.
const result = await populate();
assert.equal(result.sessions.length, 1);
const row = result.sessions[0];
assert.ok(row);
assert.deepEqual(row.childSessions, [childKey]);
for (let pass = 0; pass < 8; pass += 1) {
  gc();
  await setImmediate();
}
// Dereferencing during collection would itself keep the rows alive for that job.
const retained = retired.flatMap((reference, index) => (reference.deref() ? [index] : []));
assert.equal(control.deref(), undefined, "The uncached GC control must be collected");
assert.deepEqual(row.childSessions, [childKey]);
process.stdout.write(JSON.stringify({ retained }));
