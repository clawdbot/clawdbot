import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const requiredRuntime = {
  "fixture.mjs": "80abacf57cbfae935e9e76f652e946751417d81db08ccda81c8ec1c7369cd826",
  "passive.mjs": "fcd107d8207e62887dbed72c6ba54c80eb8981fa35b7f3373f6fff82278911a7",
};

export function verifyListenerRuntime(directory) {
  const actual = {};
  for (const [name, expected] of Object.entries(requiredRuntime)) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(directory, name))).digest("hex");
    assert.equal(digest, expected, `Listener runtime input mismatch: ${name}`);
    actual[name] = digest;
  }
  return actual;
}
