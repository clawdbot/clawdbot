import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  cleanupOwnedRuntime,
  fenceLeaseFailure,
  ownChild,
} from "./run-mock-sut-user-e2e.mjs";

function startOwnedChild() {
  return ownChild(
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    }),
  );
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

test("termination joins credential-bearing children before lease release", async () => {
  const gateway = startOwnedChild();
  const recorder = startOwnedChild();
  let released = false;
  await cleanupOwnedRuntime({
    async release() {
      assert.notEqual(gateway.signalCode, null);
      assert.notEqual(recorder.signalCode, null);
      released = true;
    },
  });
  assert.equal(released, true);
});

test("lease loss cancels and joins active cron and restart work", async () => {
  const probe = startOwnedChild();
  const cron = startOwnedChild();
  const restartedGateway = startOwnedChild();
  let controlsCancelled = false;
  let logsPersisted = false;
  const leaseError = new Error("lease heartbeat failed");
  await assert.rejects(
    fenceLeaseFailure({
      error: leaseError,
      cancelControls: () => {
        controlsCancelled = true;
      },
      probe,
      controlWork: [exited(cron), exited(restartedGateway)],
      persistLogs: () => {
        assert.equal(controlsCancelled, true);
        assert.notEqual(cron.signalCode, null);
        assert.notEqual(restartedGateway.signalCode, null);
        logsPersisted = true;
      },
    }),
    (error) => error === leaseError,
  );
  assert.equal(logsPersisted, true);
});
