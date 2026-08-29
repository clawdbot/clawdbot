import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, vi } from "vitest";
import { spawnNodeEvalSync } from "../../test-utils/node-process.js";
import { waitForPidToExit } from "../../test-utils/process-tree.js";

export const nativeBashSpillScenarios = ["fault-large", "writable-large", "fault-small"] as const;

const producerSource = String.raw`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [control, size, tracePath] = process.argv.slice(2);
let traceCount = 0;
function trace(phase, fields = {}) {
  const line = JSON.stringify({ actor: "producer", phase, at: Date.now(), ...fields }) + "\n";
  assert(++traceCount <= 32 && Buffer.byteLength(line) <= 512, "producer trace exceeded bound");
  fs.appendFileSync(tracePath, line);
}
let written = false;
let finished = false;
const timer = setTimeout(() => {
  fs.writeFileSync(path.join(control, "deadline"), "deadline");
  trace("deadline", { written, finished, releasePresent: fs.existsSync(path.join(control, "release")) });
  process.exit(92);
}, 5000);
function advance() {
  if (!written || finished || !fs.existsSync(path.join(control, "release"))) return;
  finished = true;
  trace("release-observed");
  trace("final-write-started");
  process.stdout.write("FINAL: preserve Ω🙂\n", () => {
    fs.writeFileSync(path.join(control, "completed"), "completed");
    trace("completed");
    clearTimeout(timer);
    clearInterval(readiness);
  });
}
// Read the owned marker: filesystem notifications can miss a release entirely.
const readiness = setInterval(advance, 5);
const pgid = Number(execFileSync("/bin/ps", ["-p", String(process.pid), "-o", "pgid="], {
  encoding: "utf8", timeout: 1000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
}).trim());
assert.equal(pgid, process.pid);
fs.writeFileSync(path.join(control, "producer.json"), JSON.stringify({
  pid: process.pid, ppid: process.ppid, pgid, control,
}), { flag: "wx", mode: 0o600 });
trace("ready", { pid: process.pid, ppid: process.ppid, pgid });
const prefix = size === "large" ? "BEGIN:large\n" + "x".repeat(60 * 1024) + "\n" : "BEGIN:small\n";
trace("prefix-write-started", { bytes: Buffer.byteLength(prefix) });
process.stdout.write(prefix, () => { written = true; trace("prefix-written"); advance(); });
`;

const caseSource = String.raw`
import assert from "node:assert/strict";
import { errorMonitor } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
const { root, tracePath, entrypoint, scenario, toolUrl, executorUrl } = fixture;
let traceCount = 0;
function trace(phase, fields = {}) {
  const line = JSON.stringify({ actor: "runner", phase, at: Date.now(), ...fields }) + "\n";
  assert(++traceCount <= 32 && Buffer.byteLength(line) <= 512, "runner trace exceeded bound");
  fs.appendFileSync(tracePath, line);
}
const { createBashTool, createLocalBashOperations } = await import(toolUrl);
const { executeBashWithOperations } = await import(executorUrl);
trace("imports-ready");
assert.equal(process.listenerCount("uncaughtException"), 0);
assert.equal(process.listenerCount("unhandledRejection"), 0);
assert.equal(process.hasUncaughtExceptionCaptureCallback(), false);
const fault = scenario.startsWith("fault");
const small = scenario.endsWith("small");
const spillRoot = path.join(root, fault ? "missing" : "spill");
if (!fault) fs.mkdirSync(spillRoot, { mode: 0o700 });
process.env.TMPDIR = process.env.TMP = process.env.TEMP = spillRoot;
assert.equal(os.tmpdir(), spillRoot);
assert.equal(fs.existsSync(spillRoot), !fault);
let released = false;
let settled = false;
let nativeError;
let observerFailed = false;
let creations = 0;
let prefix = "";
function release() {
  if (released) return;
  fs.writeFileSync(path.join(root, "release"), "release", { flag: "wx", mode: 0o600 });
  released = true;
  trace("release-created");
}
function observe(action) {
  // A receipt failure must not replace the native stream error under test.
  try { action(); } catch { observerFailed = true; }
}
function producerAlive() {
  const producer = JSON.parse(fs.readFileSync(path.join(root, "producer.json"), "utf8"));
  assert.equal(producer.control, root);
  assert.equal(producer.ppid, process.pid);
  assert.equal(producer.pgid, producer.pid);
  process.kill(producer.pid, 0);
  assert.equal(settled, false);
  return producer.pid;
}
function onText(text) {
  prefix = (prefix + text).slice(-64);
  if (small && prefix.includes("BEGIN:small")) release();
}
const createWriteStream = fs.createWriteStream;
fs.createWriteStream = function (...args) {
  const stream = Reflect.apply(createWriteStream, this, args);
  creations++;
  observe(() => {
    assert(stream instanceof fs.WriteStream);
    assert.equal(path.dirname(String(args[0])), spillRoot);
    trace("stream-created", { creations, settled });
  });
  stream.once(errorMonitor, (error) => observe(() => {
    nativeError = error;
    const producerPid = producerAlive();
    trace("native-error", { code: error.code, syscall: error.syscall, producerPid, settled });
    release();
    console.log(JSON.stringify({ phase: "native-error", code: error.code, syscall: error.syscall,
      producerPid, settled, observerFailed }));
  }));
  if (!fault) stream.once("open", () => observe(() => {
    trace("stream-open", { producerPid: producerAlive(), settled });
    release();
  }));
  return stream;
};
syncBuiltinESMExports();
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = "exec " + quote(process.execPath) + " " + quote(path.join(root, "producer.mjs")) +
  " " + quote(root) + " " + (small ? "small" : "large") + " " + quote(tracePath);
try {
  let result;
  let rejection;
  trace("call-started");
  try {
    result = entrypoint === "tool"
      ? await createBashTool(root, { shellPath: "/bin/bash" }).execute("native-spill", { command }, undefined,
          (update) => onText(update.content.filter((block) => block.type === "text").map((block) => block.text).join("")))
      : await executeBashWithOperations(command, root, createLocalBashOperations({ shellPath: "/bin/bash" }), { onChunk: onText });
  } catch (error) { rejection = error; }
  settled = true;
  trace("call-settled", { rejected: rejection !== undefined, observerFailed, creations });
  assert.equal(observerFailed, false);
  assert.equal(fs.existsSync(path.join(root, "deadline")), false);
  assert.equal(fs.existsSync(path.join(root, "completed")), true);
  if (fault && !small) {
    assert.equal(nativeError?.code, "ENOENT");
    assert.equal(nativeError.syscall, "open");
    assert.equal(path.dirname(nativeError.path), spillRoot);
    assert.equal(rejection, nativeError);
    assert.equal(result, undefined);
  } else {
    assert.equal(rejection, undefined);
    assert.equal(nativeError, undefined);
    const text = entrypoint === "tool" ? result.content.filter((block) => block.type === "text").map((block) => block.text).join("") : result.output;
    const fullOutputPath = entrypoint === "tool" ? result.details?.fullOutputPath : result.fullOutputPath;
    if (small) {
      assert.equal(creations, 0);
      assert.equal(fullOutputPath, undefined);
      assert.equal(text, "BEGIN:small\nFINAL: preserve Ω🙂\n");
      if (entrypoint === "tool") assert.equal(result.details?.truncation, undefined);
      else assert.equal(result.truncated, false);
    } else {
      assert.equal(path.dirname(fullOutputPath), spillRoot);
      assert.equal(fs.readFileSync(fullOutputPath, "utf8"), "BEGIN:large\n" + "x".repeat(60 * 1024) + "\nFINAL: preserve Ω🙂\n");
      assert.equal(fs.statSync(fullOutputPath).mode & 0o777, 0o600);
      if (entrypoint === "tool") {
        const footer = text.indexOf("\n\n[Showing ");
        assert(footer >= 0);
        assert.equal(text.slice(0, footer), "FINAL: preserve Ω🙂");
        assert(text.includes("Full output: " + fullOutputPath));
        assert.equal(result.details.truncation.truncated, true);
        assert(result.details.truncation.outputBytes <= 50 * 1024);
      } else {
        assert.equal(text, "FINAL: preserve Ω🙂");
        assert.equal(result.truncated, true);
        assert.equal(result.exitCode, 0);
        assert(Buffer.byteLength(text) <= 50 * 1024);
      }
    }
  }
  console.log("native Bash spill case passed");
} finally {
  fs.createWriteStream = createWriteStream;
  syncBuiltinESMExports();
}
`;

export async function expectNativeBashSpill(
  entrypoint: "tool" | "executor",
  scenario: (typeof nativeBashSpillScenarios)[number],
): Promise<void> {
  // Detached producers must outlive neither their fixture nor its cleanup proof.
  // Keep failure evidence outside the runner's auto-cleaned oc-vt namespace.
  const artifactRoot = fileURLToPath(new URL("../../../.local/", import.meta.url));
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(artifactRoot, "bash-spill-test-")));
  const tracePath = `${root}.trace`;
  let producerStopped = false;
  let childResult: ReturnType<typeof spawnNodeEvalSync> | undefined;
  const diagnostics = async () => ({
    entrypoint,
    scenario,
    fixture: root,
    status: childResult?.status,
    signal: childResult?.signal,
    spawnError: childResult?.error?.message,
    stdout: childResult?.stdout,
    stderr: childResult?.stderr,
    trace: await readFile(tracePath, "utf8").catch(() => "trace unavailable"),
  });
  try {
    await writeFile(tracePath, "", { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "producer.mjs"), producerSource, { mode: 0o600 });
    const fixture = {
      root,
      tracePath,
      entrypoint,
      scenario,
      toolUrl: new URL("./tools/bash.ts", import.meta.url).href,
      executorUrl: new URL("./bash-executor.ts", import.meta.url).href,
    };
    const result = spawnNodeEvalSync(`const fixture = ${JSON.stringify(fixture)};\n${caseSource}`, {
      imports: ["tsx"],
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: root,
        TMP: root,
        TEMP: root,
        OPENCLAW_STATE_DIR: join(root, "state"),
        OPENCLAW_OFFLINE: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_DISABLE_CACHE: "1",
      },
    });
    childResult = result;
    // The observed child is closed; release a surviving command before joining it.
    try {
      await writeFile(join(root, "release"), "release", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const producer = JSON.parse(
      await readFile(join(root, "producer.json"), "utf8").catch((error) => {
        throw new Error(
          `Missing producer receipt after child status ${result.status}: ${result.stderr}`,
          { cause: error },
        );
      }),
    );
    expect(producer.control).toBe(root);
    expect(producer.ppid).toBe(result.pid);
    expect(Number.isSafeInteger(producer.pid) && producer.pid > 0).toBe(true);
    expect(producer.pgid).toBe(producer.pid);
    expect(await waitForPidToExit(producer.pid, 5_000)).toBe(true);
    await vi.waitFor(() => {
      expect(() => process.kill(-producer.pgid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    });
    producerStopped = true;
    console.log(JSON.stringify(await diagnostics()));
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("native Bash spill case passed");
  } catch (error) {
    throw new Error(JSON.stringify(await diagnostics()), { cause: error });
  } finally {
    // A missing producer receipt or uncertain teardown must retain its files.
    if (producerStopped) {
      await rm(root, { recursive: true, force: true });
      await rm(tracePath, { force: true });
    }
  }
}
