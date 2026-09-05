// Native CLI ownership fixture; the parent keeps the real writer release gate.
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repo, root, controlUrl] = process.argv.slice(2);
assert.equal(process.platform, "win32", "this proof requires the native Windows kernel");
assert.ok(
  repo && root && controlUrl,
  "expected repository, exact owned proof root and parent HTTP gate",
);
assert.equal(typeof process.send, "function", "the external owner must hold the release gate");
const writerReady = new Promise((resolve) => {
  process.once("message", (message) => {
    assert.equal(message, "writer-ready");
    resolve();
  });
});
const fromRepo = (relative) => pathToFileURL(path.join(repo, relative)).href;
const { createVitestResourceOwner } = await import(
  fromRepo("scripts/lib/vitest-resource-ownership.mts")
);
const { withTestTimeout } = await import(fromRepo("test/helpers/promise.ts"));
const { runQaGatewayFixture } = await import(fromRepo("test/helpers/qa-gateway-cleanup.ts"));
const { isProcessAlive, waitForDead } = await import(fromRepo("test/helpers/process-wait.ts"));
const retained = path.join(root, "retained-owner");
const cwd = path.join(root, "fixture");
await fs.mkdir(retained);
await fs.mkdir(path.join(cwd, "dist"), { recursive: true });
const resourceOwner = createVitestResourceOwner(retained);
for (const key of ["TMPDIR", "TMP", "TEMP"]) {
  process.env[key] = retained;
}

const spawned = [];
const taskkills = [];
const originalSpawn = childProcess.spawn;
const originalSpawnSync = childProcess.spawnSync;
childProcess.spawn = function (...args) {
  const child = Reflect.apply(originalSpawn, this, args);
  if (args[2]?.cwd === cwd) {
    const exited = once(child, "exit");
    const closed = once(child, "close");
    void exited.catch(() => {});
    void closed.catch(() => {});
    spawned.push({ child, exited, closed });
  }
  return child;
};
childProcess.spawnSync = function (...args) {
  const result = Reflect.apply(originalSpawnSync, this, args);
  if (path.basename(String(args[0])).toLowerCase() === "taskkill.exe") {
    taskkills.push({ args: args[1], status: result.status, errorCode: result.error?.code });
  }
  return result;
};
syncBuiltinESMExports();

let instance;
let outcome;
let writerPid;
let retainedFailure;
let primary;
let cleanupFailure;
const facts = { platform: process.platform, node: process.version, taskkills };
try {
  // The writer must survive its leader; Windows needs detachment to keep inherited stderr open.
  await Promise.all([
    fs.writeFile(path.join(cwd, "dist", ".buildstamp"), ""),
    fs.writeFile(path.join(cwd, "dist", ".runtime-postbuildstamp"), ""),
    fs.writeFile(
      path.join(cwd, "dist", "index.mjs"),
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const writer = spawn(process.execPath, ["-e", 'require("node:http").get(process.argv[1], response => { response.resume(); response.on("end", () => process.stderr.write(process.argv[2], () => process.exit(0))); });', ${JSON.stringify(controlUrl)}, ${JSON.stringify("held stderr drained\n")}], { detached: true, stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(${JSON.stringify(path.join(cwd, "writer.pid"))}, String(writer.pid));
process.exit(1);
`,
    ),
  ]);
  const { createOpenClawTestInstance } = await import(
    fromRepo("test/helpers/openclaw-test-instance.ts")
  );
  const { hasUnjoinedWork } = await import(fromRepo("scripts/lib/managed-child-process.mts"));
  instance = await createOpenClawTestInstance({ name: "native-cli-output-owner", cwd });
  outcome = instance.cli(["fixture"], { timeoutMs: 10_000 }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await withTestTimeout(
    Promise.race([
      writerReady,
      outcome.then((result) => {
        const detail = result.error?.message ?? JSON.stringify(result.value);
        throw new Error(`CLI completed before the writer reached its gate: ${detail}`, {
          cause: result.error,
        });
      }),
    ]),
    5_000,
    "inherited-stderr fixture did not reach readiness",
  );
  assert.equal(spawned.length, 1);
  const leader = spawned[0];
  await withTestTimeout(leader.exited, 5_000, "CLI leader did not exit after writer readiness");
  writerPid = Number(await fs.readFile(path.join(cwd, "writer.pid"), "utf8"));
  assert.ok(Number.isSafeInteger(writerPid) && writerPid > 1);
  assert.equal(leader.child.exitCode, 1);
  assert.equal(leader.child.signalCode, null);
  assert.equal(leader.child.stderr.closed, false);
  assert.equal(isProcessAlive(writerPid), true);
  facts.boundaryEstablished = true;
  const result = await outcome;
  const error = result.error;
  retainedFailure = error;
  facts.commandError = error
    ? {
        message: error.message,
        causeCode: error.cause?.code,
        processTreeState: error.cause?.processTreeState,
        manualRecoveryRequired: error.cause?.manualRecoveryRequired,
      }
    : null;
  facts.writerAliveAtSettlement = isProcessAlive(writerPid);
  facts.pipeClosedAtSettlement = leader.child.stderr.closed;
  facts.statePresentAtSettlement = await fs.stat(instance.state.root).then(
    () => true,
    () => false,
  );
  facts.retainedClaim = (() => {
    try {
      resourceOwner.assertReleased();
      return false;
    } catch (claimError) {
      assert.match(claimError.message, /Unreleased Vitest resource claim/);
      return true;
    }
  })();
  assert.equal(
    hasUnjoinedWork(error),
    true,
    "a dead leader cannot certify its held Windows descendant",
  );
  assert.equal(error.cause?.code, "EPROCESSGROUP_CLEANUP_FAILED");
  assert.equal(error.cause?.processTreeState, "indeterminate");
  assert.equal(error.cause?.manualRecoveryRequired, true);
  assert.equal(facts.writerAliveAtSettlement, true);
  assert.equal(facts.pipeClosedAtSettlement, false);
  assert.equal(facts.statePresentAtSettlement, true);
  assert.equal(facts.retainedClaim, true);
  await assert.rejects(instance.cli(["fixture"]), /no longer accepts CLI commands/);
  await assert.rejects(instance.startGateway(), /no longer accepts Gateway starts/);
  const firstCleanup = instance.cleanup();
  const secondCleanup = instance.cleanup();
  assert.equal(secondCleanup, firstCleanup);
  await assert.rejects(firstCleanup, (received) => received === error);
  await assert.rejects(instance.cleanup(), (received) => received === error);
  assert.equal(spawned.length, 1);
  await fs.stat(instance.state.root);
  facts.retentionAndAdmissionVerified = true;
} catch (error) {
  primary = error;
} finally {
  try {
    await runQaGatewayFixture(
      () =>
        new Promise((resolve, reject) => {
          process.send(
            "release-writer",
            /** @param {Error | null} sendError */
            (sendError) => (sendError ? reject(sendError) : resolve()),
          );
        }),
      async () => {
        await runQaGatewayFixture(
          async () => {
            if (outcome) {
              await outcome;
            }
            await instance?.stopGateway();
          },
          async () => {
            await withTestTimeout(
              Promise.all(spawned.map((item) => item.closed)),
              5_000,
              "owned CLI pipes did not close after releasing the writer",
            );
            if (writerPid === undefined) {
              writerPid = await fs
                .readFile(path.join(cwd, "writer.pid"), "utf8")
                .then(Number, () => undefined);
            }
            if (spawned.some(({ child }) => child.pid) && writerPid === undefined) {
              throw new Error("spawned CLI did not leave a verifiable writer identity");
            }
            if (writerPid !== undefined) {
              assert.ok(
                Number.isSafeInteger(writerPid) && writerPid > 1,
                "invalid writer identity",
              );
              facts.writerPid = writerPid;
              await waitForDead(writerPid, 5_000);
            }
            facts.allOwnedPipesClosed = spawned.every(
              ({ child }) => child.stdout.closed && child.stderr.closed,
            );
            facts.writerDeadAfterRescue = writerPid === undefined || !isProcessAlive(writerPid);
            assert.equal(facts.allOwnedPipesClosed, true);
            assert.equal(facts.writerDeadAfterRescue, true);
          },
        );
        if (facts.retentionAndAdmissionVerified) {
          await assert.rejects(instance.cleanup(), (received) => received === retainedFailure);
          await fs.stat(instance.state.root);
          facts.failedCleanupSurvivedRescue = true;
        }
        // An external verified rescue owns disposal; the instance's failed cleanup stays failed.
        await instance?.state.cleanup();
        if (instance) {
          await assert.rejects(fs.stat(instance.state.root), { code: "ENOENT" });
        }
        facts.stateRemovedAfterVerifiedRescue = true;
      },
    );
  } catch (error) {
    cleanupFailure = error;
  } finally {
    childProcess.spawn = originalSpawn;
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
}
facts.proofFailure = primary ? { name: primary.name, message: primary.message } : null;
facts.cleanupFailure = cleanupFailure
  ? { name: cleanupFailure.name, message: cleanupFailure.message }
  : null;
// Leave the real pending receipt intact. The enclosing owner may dispose of this
// private proof namespace only after this report, native child close and its own PID check.
await fs.writeFile(path.join(root, "native-cli-proof.json"), JSON.stringify(facts, null, 2) + "\n");
if (primary || cleanupFailure) {
  process.stderr.write(JSON.stringify(facts) + "\n");
}
process.exitCode = primary || cleanupFailure ? 1 : 0;
process.disconnect();
