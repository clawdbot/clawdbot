import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { createDeferredCore } from "../shared/deferred.js";
import { activeRuns, disposeAllCodeModeRuns } from "./code-mode-state.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const started = { done: createDeferredCore(), pending: createDeferredCore() };
const release = { done: createDeferredCore(), pending: createDeferredCore() };
const inputs = new Map<string, WeakRef<object>>();
const calls: string[] = [];
const target: AnyAgentTool = {
  name: "retain_input",
  label: "Retain input",
  description: "A controlled input lifetime fixture.",
  parameters: Type.Object({ kind: Type.String() }),
  execute: async (_id, input) => {
    assert.ok(isRecord(input));
    const kind = input.kind;
    assert.ok(kind === "done" || kind === "pending");
    inputs.set(kind, new WeakRef(input));
    calls.push(kind);
    started[kind].resolve();
    await release[kind].promise;
    return jsonResult({ kind: input.kind });
  },
};
const config = { tools: { codeMode: true } };
const ctx = {
  config,
  runtimeConfig: config,
  catalogRef: createToolSearchCatalogRef(),
  sessionId: "retention-session",
  sessionKey: "agent:main:retention",
  runId: "retention-run",
};
const tools = createCodeModeTools(ctx);
applyCodeModeCatalog({ ...ctx, tools: [...tools, target] });
const exec = tools.find((tool) => tool.name === "exec");
const wait = tools.find((tool) => tool.name === "wait");
assert.ok(exec && wait);
function unownedControl() {
  return new WeakRef({ unowned: true });
}
const control = unownedControl();
let pending: Promise<unknown>[] = [];
try {
  const response = await exec.execute("park-inputs", {
    code: 'const done = retain_input({ kind: "done" }); const pending = retain_input({ kind: "pending" }); await yield_control(); return await Promise.all([done, pending]);',
  });
  assert.ok(isRecord(response.details));
  assert.equal(response.details.status, "waiting");
  const runId = response.details.runId;
  assert.ok(typeof runId === "string");
  const state = activeRuns.get(runId);
  assert.ok(state);
  pending = state.pending.map((entry) => entry.promise);
  await Promise.all([started.done.promise, started.pending.promise]);
  const completed = state.pending.find(
    (entry) => isRecord(entry.args[1]) && entry.args[1].kind === "done",
  );
  assert.ok(completed);
  release.done.resolve();
  await completed.promise;
  // A parked cell still owns responses; completed inputs must not ride along.
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(inputs.get("done")?.deref(), undefined, "Settled input must be released");
  assert.ok(inputs.get("pending")?.deref(), "Pending input must remain usable");
  release.pending.resolve();
  const resumed = await wait.execute("resume-inputs", { runId });
  assert.ok(isRecord(resumed.details));
  assert.equal(resumed.details.status, "completed");
  assert.deepEqual(resumed.details.value, [{ kind: "done" }, { kind: "pending" }]);
  assert.deepEqual(calls, ["done", "pending"]);
  assert.equal(activeRuns.size, 0);
  process.stdout.write(
    JSON.stringify({ completedInputReleased: true, pendingInputPreserved: true }),
  );
} finally {
  release.done.resolve();
  release.pending.resolve();
  disposeAllCodeModeRuns();
  await Promise.allSettled(pending);
  clearToolSearchCatalog(ctx);
}
