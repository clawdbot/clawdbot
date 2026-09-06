import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { withCiCheckoutFixture } from "./ci-checkout.test-support.js";
import { fixturePreloadEnv } from "./fixtures/ci-fixture-runtime.cjs";

export function censusPreload(root: string, extra = "", delayed = false) {
  const preload = path.join(root, "census-preload.mjs");
  writeFileSync(
    preload,
    String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
const root = process.argv[3];
const delayed = ` +
      JSON.stringify(delayed) +
      String.raw`;
const censusArgs = args => delayed && args?.[2]?.endsWith("ci-windows-process-census.py")
  ? ["-I", "-S", "-c", "import runpy,sys,time; time.sleep(1.1); sys.argv=sys.argv[1:]; runpy.run_path(sys.argv[0],run_name='__main__')", ...args.slice(2)]
  : args;
const spawn = cp.spawn, spawnSync = cp.spawnSync;
// Delay the actual interpreter entry point, including the pre-fix synchronous path.
cp.spawnSync = (command, args, options) => spawnSync(command, censusArgs(args), options);
cp.spawn = (command, args, options) => {
  const child = spawn(command, censusArgs(args), options);
  if (command === "python" && process.argv[2] === "supervise") {
    const record = event => fs.appendFileSync(path.join(root, "census-lifetime.jsonl"), JSON.stringify(event) + "\n");
    record({ event: "spawn", pid: child.pid });
    child.once("close", (code, signal) => record({ event: "close", pid: child.pid, code, signal,
      reportExists: fs.existsSync(path.join(root, "report.json")) }));
  }
  return child;
};
syncFixtureBuiltinExports();
` +
      extra,
  );
  return fixturePreloadEnv(preload);
}

export function expectCensusClosed(root: string, actorPids: number[]) {
  if (process.platform !== "win32") {
    return;
  }
  const [created, closed, ...extra] = readFileSync(path.join(root, "census-lifetime.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(extra, "one sampler belongs to each supervisor").toEqual([]);
  expect(created).toEqual({ event: "spawn", pid: expect.any(Number) });
  expect(closed).toMatchObject({ event: "close", pid: created.pid, reportExists: false });
  expect(actorPids).not.toContain(created.pid);
  // The creator-owned close proves this instance retired; its PID may already be reused.
  expect(typeof closed.code === "number" || typeof closed.signal === "string").toBe(true);
  expect(existsSync(path.join(root, "census.json"))).toBe(false);
}

export function registerWindowsCensusTests() {
  // Exercise the real broker/stdio owner on any platform; only the native sampler
  // is replaced. The concurrent matrix and PID-reuse test retain native API proof.
  it.each([
    "ready",
    "startup",
    "query",
    "stderr-reply",
    "late",
    "mismatched",
    "birth",
    "truncated",
    "lease",
    "retire",
  ])(
    "owns the Windows census helper through %s",
    async (fault) => {
      const sampler = String.raw`
import { createInterface } from "node:readline";
const fault = process.argv[1];
let pendingReply;
const reply = ({ id, pids }) => console.log(JSON.stringify({ id: fault === "mismatched" ? id + 1 : id,
  observations: pids.map(pid => ({ pid, alive: true, creationTime: fault === "birth" ? null : pid === 101 ? "5001" : "6002" })) }));
createInterface({ input: process.stdin }).on("line", line => {
  if (line === "stderr-observed") {
    if (fault === "startup" || fault === "query") {
      const message = fault === "startup" ? "injected sampler startup failure" : "injected native query failure";
      process.stderr.write(message + "\n", () => process.exit(fault === "startup" ? 23 : 24));
    } else {
      // Stay alive after the valid reply: an exit must not mask accidental acceptance.
      reply(pendingReply);
    }
    return;
  }
  const request = JSON.parse(line);
  if (fault === "query" || fault === "stderr-reply") {
    pendingReply = request;
    process.stderr.write("injected traceback prefix\n");
    return;
  }
  if (fault === "truncated") { process.stdout.write('{"id":'); process.stdin.destroy(); return; }
  reply(request);
});
if (fault === "startup") process.stderr.write("injected traceback prefix\n");
else if (fault !== "retire") console.log(JSON.stringify({ ready: true }));
`;
      const { child, completion } = spawnOwnedVitestProcess({
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
import { tmpdir } from "node:os";
import path from "node:path";
const [moduleUrl, fault, sampler] = process.argv.slice(1);
const root = fs.mkdtempSync(path.join(tmpdir(), "census-"));
fs.writeFileSync(path.join(root, "lease"), "owned");
const endpoint = path.join(root, "census.json");
const children = [], closes = [];
let stderrObserved = false, mixedReply;
const spawn = cp.spawn;
cp.spawn = (command, args, options) => {
  assert.equal(command, "python");
  const child = spawn(process.execPath, ["--input-type=module", "-e", sampler, fault], options);
  children.push(child);
  child.once("close", (code, signal) => closes.push({ pid: child.pid, code, signal, endpoint: fs.existsSync(endpoint) }));
  if (["startup", "query", "stderr-reply"].includes(fault)) {
    const on = child.stderr.on;
    child.stderr.on = function(event, listener) {
      if (event !== "data") return on.call(this, event, listener);
      return on.call(this, event, function(chunk) {
        const result = listener.call(this, chunk);
        // Acknowledge only after the real owner has processed stderr. Its pre-fix
        // SIGKILL prevents the sampler from emitting the terminal diagnostic/reply.
        if (!stderrObserved) {
          stderrObserved = true;
          child.stdin.write("stderr-observed\n");
        }
        return result;
      });
    };
  }
  if (fault === "stderr-reply") {
    let buffered = "";
    child.stdout.on("data", chunk => {
      buffered += String(chunk);
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const frame = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (frame.observations) {
          assert(stderrObserved, "mixed reply preceded owner-observed stderr");
          mixedReply = frame;
        }
      }
    });
  }
  if (fault === "late") child.stdout.prependListener("data", chunk => {
    if (String(chunk).includes('"id"')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  });
  if (fault === "lease") {
    const write = child.stdin.write.bind(child.stdin);
    child.stdin.write = (...args) => {
      const result = write(...args);
      fs.writeFileSync(path.join(root, "lease"), "replacement");
      return result;
    };
  }
  return child;
};
syncFixtureBuiltinExports();
const { createWindowsProcessCensus, requestWindowsProcessCensus } = await import(moduleUrl);
const failures = [];
const owner = createWindowsProcessCensus({ root, token: "owned", onFailure: error => failures.push(String(error)) });
let accepted = false, rejected;
try {
  if (fault === "retire") await owner.close();
  await owner.ready;
  // A sibling's ingress rejection must not hide stale success from an already
  // admitted lease or stderr-fault request.
  const pids = ["lease", "query", "stderr-reply"].includes(fault) ? [101] : [101, 202];
  const results = await Promise.all(pids.map(pid => requestWindowsProcessCensus(root, "owned", [pid])));
  assert.deepEqual(results.map(result => [...result.values()]), pids.map(pid => [
    { pid, alive: true, creationTime: pid === 101 ? "5001" : "6002" },
  ]));
  accepted = true;
} catch (error) { rejected = String(error); }
finally { await owner.close(); }
assert.equal(children.length, 1);
assert.equal(closes.length, 1, "retirement must join actual child/stdio close");
assert.equal(closes[0].endpoint, fault !== "startup" && fault !== "retire", "endpoint retired before sampler close");
assert(!fs.existsSync(endpoint));
await assert.rejects(async () => requestWindowsProcessCensus(root, "owned", [101]));
await assert.rejects(async () => owner.read([101]));
assert.equal(accepted, fault === "ready", rejected);
if (fault === "ready") assert.deepEqual(failures, []);
else assert(rejected, "fault was accepted");
if (!["ready", "lease", "retire"].includes(fault)) assert.equal(failures.length, 1);
const diagnostics = owner.diagnostics();
if (fault === "startup") assert(diagnostics.includes("injected sampler startup failure"), diagnostics);
if (fault === "query") assert(diagnostics.includes("injected native query failure"), diagnostics);
if (fault === "startup" || fault === "query") {
  assert(stderrObserved, "owner never observed the diagnostic prefix");
  assert.equal(closes[0].code, fault === "startup" ? 23 : 24, diagnostics);
  assert.equal(closes[0].signal, null, diagnostics);
}
if (fault === "stderr-reply") {
  assert(stderrObserved, "owner never observed stderr before the valid reply");
  assert.deepEqual(mixedReply?.observations, [{ pid: 101, alive: true, creationTime: "5001" }],
    "sampler must deliver a valid reply after stderr so rejection is not vacuous");
}
if (fault === "late") assert(/Late|ETIMEDOUT/.test(diagnostics));
console.log(JSON.stringify({ fault, accepted, rejected, diagnostics, closes, stderrObserved, mixedReply }));
fs.rmSync(root, { recursive: true });
`,
          new URL("./fixtures/ci-windows-process-census.mjs", import.meta.url).href,
          fault,
          sampler,
        ],
        options: { stdio: ["ignore", "pipe", "pipe"] },
      });
      let stdout = "",
        stderr = "";
      child.stdout?.on("data", (data) => (stdout += String(data)));
      child.stderr?.on("data", (data) => (stderr += String(data)));
      const result = await completion;
      // Simulated census faults do not revoke the outer process owner's actual join.
      expect(result, stdout + stderr).toEqual({
        code: 0,
        signal: null,
        groupJoined: process.platform !== "win32",
      });
      expect(JSON.parse(stdout)).toMatchObject({ fault, accepted: fault === "ready" });
    },
    55_000,
  );

  it.each(["sentinel", ...(process.platform === "win32" ? ["startup", "query", "lease"] : [])])(
    "retains startup errors and joins census before registration (%s)",
    async (fault) => {
      await withCiCheckoutFixture(
        "early-leader-exit",
        (root) => {
          writeFileSync(path.join(root, "checkout.sh"), "exit 99\n");
          const sampler = String.raw`
import json, pathlib, runpy, sys
fault = sys.argv[3]
if fault == "startup":
    raise RuntimeError("injected sampler startup failure")
print(json.dumps(dict(ready=True)), flush=True)
for line in sys.stdin:
    if fault == "query":
        raise RuntimeError("injected native query failure")
    request = json.loads(line)
    observations = runpy.run_path(sys.argv[2])["read_processes"](request["pids"])
    pathlib.Path(sys.argv[1], "lease").write_text("replacement")
    print(json.dumps(dict(id=request["id"], observations=observations)), flush=True)
`;
          return censusPreload(
            root,
            fault === "sentinel"
              ? 'if (process.argv[2] === "sentinel") throw new Error("injected sentinel startup failure");\n'
              : `if (process.argv[2] === "supervise") {
  const censusSpawn = cp.spawn;
  cp.spawn = (command, args, options) => censusSpawn(command, command === "python"
    ? ["-I", "-S", "-c", ${JSON.stringify(sampler)}, root, args[2], ${JSON.stringify(fault)}] : args, options);
  syncFixtureBuiltinExports();
}`,
          );
        },
        (report, result, stderr, root) => {
          expectCensusClosed(
            root,
            report.ownedProcesses.map((entry) => entry.pid),
          );
          expect(result, stderr).toEqual({ code: 1, signal: null });
          if (fault === "sentinel") {
            expect(report.error).toBe("Error: Sentinel exited before readiness (1)");
            expect(report.output).toContain("injected sentinel startup failure");
          } else if (fault === "lease") {
            expect(report.error).toContain("Sentinel exited before readiness");
          } else {
            expect(report.error).toContain(
              fault === "startup"
                ? "injected sampler startup failure"
                : "injected native query failure",
            );
          }
          expect(report.ownedProcesses).toEqual([]);
          expect(report.cleanupRemaining).toEqual([]);
          expect(report.commands).toEqual([]);
        },
      );
    },
    55_000,
  );

  it("joins an unregistered sentinel before supervisor close on disconnect", async () => {
    await withCiCheckoutFixture(
      "early-leader-exit",
      (root) => {
        writeFileSync(path.join(root, "checkout.sh"), "exit 99\n");
        // Fault only the asynchronous startup boundary; keep the real safe preflight.
        return censusPreload(
          root,
          String.raw`
import assert from "node:assert/strict";
const mode = process.argv[2];
if (mode === "sentinel") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "supervise") {
  const sentinelSpawn = cp.spawn;
  cp.spawn = (...args) => {
    const child = sentinelSpawn(...args);
    if (args[1]?.[1] === "sentinel") {
      assert(child.pid > 1, "sentinel spawn did not return an owned PID");
      // Record at the creator: proof must not depend on sentinel JS ever starting.
      fs.writeFileSync(path.join(root, "spawned-pid"), String(child.pid));
      child.once("close", (code, signal) => {
        fs.writeFileSync(path.join(root, "sentinel-close.json"), JSON.stringify({
          pid: child.pid, code, signal, reportExists: fs.existsSync(path.join(root, "report.json")),
        }));
      });
      queueMicrotask(() => process.disconnect());
    }
    return child;
  };
  syncFixtureBuiltinExports();
}
`,
        );
      },
      (report, result, stderr, root) => {
        expectCensusClosed(
          root,
          report.ownedProcesses.map((entry) => entry.pid),
        );
        const spawnedPid = path.join(root, "spawned-pid");
        const sentinelClose = path.join(root, "sentinel-close.json");
        expect(report.error, stderr).toBe("test parent disconnected");
        const pid = Number(readFileSync(spawnedPid, "utf8"));
        expect(JSON.parse(readFileSync(sentinelClose, "utf8"))).toEqual({
          pid,
          code: null,
          signal: "SIGKILL",
          reportExists: false,
        });
        expect(result, stderr).toEqual({ code: 1, signal: null });
        expect(report.ownedProcesses).toEqual([]);
        expect(report.cleanupRemaining).toEqual([]);
        expect(report.boundaries).toEqual([]);
        expect(report.commands).toEqual([]);
      },
    );
  }, 55_000);

  it.each(["direct-child-close", "truthful-final-census"])(
    "rejects expired supervisor cleanup and joins census (%s)",
    async (fault) => {
      type BoundaryEvent = {
        event: string;
        role?: string;
        pid?: number;
        code?: number | null;
        signal?: string | null;
        reportExists: boolean;
      };
      const readEvents = (directory: string): BoundaryEvent[] =>
        readFileSync(path.join(directory, "cleanup-boundary.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
      let root: string | undefined;
      let completedReport = false;
      let events: BoundaryEvent[] = [];
      let failure: unknown;
      await withCiCheckoutFixture(
        "early-leader-exit",
        (directory) => {
          root = directory;
          writeFileSync(path.join(root, "checkout.sh"), "exit 0\n");
          return censusPreload(
            root,
            "const cleanupFault = " +
              JSON.stringify(fault) +
              ";\n" +
              String.raw`
import assert from "node:assert/strict";
const mode = process.argv[2];
if (mode === "sentinel" && cleanupFault === "direct-child-close") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (mode === "supervise") {
  const lease = path.join(root, "lease");
  const recordBoundary = event => fs.appendFileSync(path.join(root, "cleanup-boundary.jsonl"),
    JSON.stringify({ ...event, reportExists: fs.existsSync(path.join(root, "report.json")) }) + "\n");
  const realNow = Date.now;
  let advanced = false;
  const advanceClock = () => {
    if (advanced) return;
    assert(!fs.existsSync(lease), "fault must occur inside teardown");
    advanced = true;
    Date.now = () => realNow() + 4_001;
    recordBoundary({ event: "clock-advanced" });
  };
  const ownedSpawn = cp.spawn;
  cp.spawn = (command, args, options) => {
    const child = ownedSpawn(command, args, options);
    const role = command === "python" ? "helper" : args?.[1] === "sentinel" ? "sentinel" : "shell";
    recordBoundary({ event: "spawn", role, pid: child.pid });
    child.once("close", (code, signal) => {
      recordBoundary({ event: "close", role, pid: child.pid, code, signal });
      if (role === "sentinel" && cleanupFault === "direct-child-close") advanceClock();
    });
    if (role === "helper") {
      // Defer delivery of the REAL close once; never synthesize process extinction.
      const emit = child.emit;
      child.emit = function(event, ...values) {
        if (event !== "close") return emit.call(this, event, ...values);
        child.emit = emit;
        setImmediate(() => emit.call(child, event, ...values));
        return true;
      };
      if (cleanupFault === "truthful-final-census") {
        const on = child.stdout.on;
        let buffered = "";
        child.stdout.on = function(event, listener) {
          if (event !== "data") return on.call(this, event, listener);
          return on.call(this, event, function(chunk) {
            // Validate with the actual broker callback before moving the cleanup clock.
            const result = listener.call(this, chunk);
            buffered += String(chunk);
            for (;;) {
              const newline = buffered.indexOf("\n");
              if (newline < 0) break;
              const message = JSON.parse(buffered.slice(0, newline));
              buffered = buffered.slice(newline + 1);
              if (!advanced && !fs.existsSync(lease) && message.observations) {
                assert(message.observations.length > 0, "final census must observe registered actor births");
                recordBoundary({ event: "census-validated" });
                advanceClock();
              }
            }
            return result;
          });
        };
      }
    }
    // Let the fixture install tracking before disconnect can start stop().
    if (role === "sentinel" && cleanupFault === "direct-child-close") {
      queueMicrotask(() => process.disconnect());
    }
    return child;
  };
  if (process.platform !== "win32" && cleanupFault === "truthful-final-census") {
    const writeFileSync = fs.writeFileSync;
    fs.writeFileSync = (target, ...values) => {
      const result = writeFileSync(target, ...values);
      if (!advanced && !fs.existsSync(lease) && typeof target === "string" &&
          path.dirname(target) === path.join(root, "pids") && target.endsWith(".dead")) {
        // Receipt publication follows the real native census; this microtask precedes
        // the awaited cleanup predicate's continuation without expiring the native query.
        queueMicrotask(() => {
          if (advanced) return;
          recordBoundary({ event: "census-validated" });
          advanceClock();
        });
      }
      return result;
    };
  }
  process.once("exit", code => recordBoundary({ event: "supervisor-exit", code }));
  syncFixtureBuiltinExports();
}
`,
          );
        },
        (_report, _result, _stderr, directory) => {
          completedReport = true;
          // Preserve evidence before the existing outer owner removes an accepted report.
          events = readEvents(directory);
        },
      ).catch((error: unknown) => {
        failure = error;
      });
      const directory = expectDefined(root, "created cleanup fault namespace");
      if (existsSync(directory)) {
        events = readEvents(directory);
      }
      console.log(
        JSON.stringify({
          fault,
          root: directory,
          completedReport,
          events,
          failure: String(failure),
        }),
      );
      expect(events.filter((event) => event.event === "clock-advanced")).toHaveLength(1);
      expect(events.filter((event) => event.event === "census-validated")).toHaveLength(
        fault === "truthful-final-census" ? 1 : 0,
      );
      const spawned = events.filter((event) => event.event === "spawn");
      const expectedRoles = [
        "sentinel",
        ...(fault === "truthful-final-census" ? ["shell"] : []),
        ...(process.platform === "win32" ? ["helper"] : []),
      ];
      const spawnedRoles = spawned.map((event) => expectDefined(event.role, "spawned role"));
      expect(spawnedRoles.toSorted()).toEqual(expectedRoles.toSorted());
      const supervisorExit = events.findIndex((event) => event.event === "supervisor-exit");
      expect(supervisorExit).toBeGreaterThanOrEqual(0);
      for (const created of spawned) {
        const closed = events.filter(
          (event) => event.event === "close" && event.role === created.role,
        );
        expect(
          closed,
          `${created.role} must deliver its creator-owned close before supervisor exit`,
        ).toHaveLength(1);
        const receipt = expectDefined(closed[0], "creator-owned close receipt");
        expect(receipt).toMatchObject({ pid: created.pid, reportExists: false });
        expect(typeof receipt.code === "number" || typeof receipt.signal === "string").toBe(true);
        expect(events.indexOf(receipt)).toBeLessThan(supervisorExit);
      }
      expect(completedReport, "expired cleanup must not publish a completed report").toBe(false);
      expect(failure).toMatchObject({ code: "ENOENT", path: path.join(directory, "report.json") });
      expect(events[supervisorExit]).toMatchObject({ code: 1, reportExists: false });
      expect(existsSync(directory), "failed cleanup must retain its namespace").toBe(true);
      expect(existsSync(path.join(directory, "report.json"))).toBe(false);
      expectCensusClosed(directory, []);
      // Missing-report rejection follows the outer owner's actual supervisor-close join.
      // Every spawned writer above also has a creator-held close; failures retain evidence.
      rmSync(directory, { recursive: true });
    },
    55_000,
  );
}
