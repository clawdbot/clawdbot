import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Source verification and native measurement stay with their callers; this owns durable admission.
export function admitProof({ root, identity, verifySource, measure, redact }) {
  assert(!existsSync(root), "Preserve prior evidence; no overwrite or unchanged retry");
  const publicOutput = path.join(root, "public");
  mkdirSync(publicOutput, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(root, "private"), { mode: 0o700 });
  const preflight = { ...identity, state: "starting", stage: "source", sourceVerified: false };
  const save = () =>
    writeFileSync(
      path.join(publicOutput, "preflight.json"),
      redact(JSON.stringify(preflight, null, 2)) + "\n",
    );
  const record = (event, details = {}) =>
    appendFileSync(
      path.join(publicOutput, "phase.jsonl"),
      redact(JSON.stringify({ at: Date.now(), event, ...details })) + "\n",
    );
  save();
  try {
    Object.assign(preflight, verifySource(record));
    preflight.sourceVerified = true;
    preflight.stage = "measurement";
    save();
    preflight.measurement = measure(record);
    const sample = preflight.measurement;
    const gib = 1024 ** 3;
    preflight.conditions = {
      physicalMemory: sample.memory >= 6 * gib,
      freeMemory: sample.freeMemory >= 2 * gib,
      runnerResidentMemory: sample.runnerUserRSS < 5 * gib,
      disk: sample.freeDisk >= 24 * gib,
    };
    preflight.stage = "admission";
    preflight.state = "measured";
    save();
    record("admission-measurement", sample);
    assert(preflight.conditions.physicalMemory, "Need at least 6 GiB physical Mac memory");
    assert(preflight.conditions.freeMemory, "Need at least 2 GiB free-plus-inactive Mac memory");
    assert(
      preflight.conditions.runnerResidentMemory,
      "Runner-user RSS must remain below 5 GiB at entry",
    );
    assert(preflight.conditions.disk, "Need 20 GiB normal writes and 4 GiB exit/export reserve");
    preflight.state = "admitted";
    save();
    record("admitted-measurement", sample);
    return { preflight, record };
  } catch (error) {
    preflight.state = "refused";
    preflight.error = String(error);
    save();
    record("admission-refused", {
      stage: preflight.stage,
      sourceVerified: preflight.sourceVerified,
      error: String(error),
    });
    throw error;
  }
}
