import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readCommand } from "./command-read.mjs";

function journal() {
  const root = mkdtempSync(path.join(tmpdir(), "f26-command-read-"));
  mkdirSync(path.join(root, "public"));
  const file = path.join(root, "public", "phase.jsonl");
  return {
    file,
    record(event, details) {
      appendFileSync(file, JSON.stringify({ event, ...details }) + "\n");
    },
  };
}

test("a nonzero query preserves both output streams and exit identity before refusal propagates", () => {
  const output = journal();
  const args = [
    "--input-type=module",
    "-e",
    'import {writeSync} from "node:fs"; writeSync(1,"partial physical sample\\n"); writeSync(2,"query diagnostic\\n"); process.exitCode=7;',
  ];
  assert.throws(
    () => readCommand(process.execPath, args, output.record),
    (error) => {
      const entry = JSON.parse(readFileSync(output.file, "utf8"));
      assert.equal(entry.event, "command-read-failed");
      assert.equal(entry.command, process.execPath);
      assert.deepEqual(entry.args, args);
      assert.equal(entry.complete, false);
      assert.equal(entry.stdout, "partial physical sample\n");
      assert.equal(entry.stderr, "query diagnostic\n");
      assert.equal(entry.status, 7);
      assert.equal(entry.signal, null);
      assert.equal(error.status, 7);
      return true;
    },
  );
});

test("a timed-out query retains emitted bytes and termination metadata without a successful sample", () => {
  const output = journal();
  const args = [
    "--input-type=module",
    "-e",
    'import {writeSync} from "node:fs"; writeSync(1,"partial process table\\n"); writeSync(2,"still reading\\n"); setInterval(()=>{},1000);',
  ];
  assert.throws(
    () => readCommand(process.execPath, args, output.record),
    (error) => {
      const entry = JSON.parse(readFileSync(output.file, "utf8"));
      assert.equal(entry.command, process.execPath);
      assert.deepEqual(entry.args, args);
      assert.equal(entry.complete, false);
      assert.equal(entry.stdout, "partial process table\n");
      assert.equal(entry.stderr, "still reading\n");
      assert.equal(entry.status, null);
      assert.equal(entry.signal, "SIGTERM");
      assert.equal(entry.code, "ETIMEDOUT");
      assert.equal(error.code, "ETIMEDOUT");
      return true;
    },
  );
});

test("successful query text keeps the existing trimmed result and writes no failure", () => {
  const output = journal();
  const result = readCommand(
    process.execPath,
    ["-e", 'process.stdout.write("  6442450944\\n")'],
    output.record,
  );
  assert.equal(result, "6442450944");
  assert.equal(existsSync(output.file), false);
});
