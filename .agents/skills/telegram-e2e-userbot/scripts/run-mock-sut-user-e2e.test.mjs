import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupOwnedRuntime,
  createScenarioCommandEnvironment,
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

test("scenario commands cannot persist parent control-plane secrets", () => {
  const sentinel = "must-not-reach-scenario-summary";
  const credentialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-env-test-"));
  const userDriverRoot = path.join(credentialRoot, "user-driver");
  fs.mkdirSync(path.join(userDriverRoot, "db"), { recursive: true });
  for (const pathname of [
    path.join(credentialRoot, "credentials.local.json"),
    path.join(userDriverRoot, "config.local.json"),
    path.join(userDriverRoot, "db", "td_test.binlog"),
  ]) {
    fs.writeFileSync(pathname, sentinel);
  }
  const env = createScenarioCommandEnvironment({
    configPath: "/tmp/disposable-sut-config.json",
    stateDir: "/tmp/disposable-sut-state",
    baseEnv: {
      PATH: process.env.PATH,
      E2E_SAFE_VALUE: "safe-value",
      OPENCLAW_QA_CONVEX_SITE_URL: "https://broker.example.test",
      OPENCLAW_QA_CONVEX_SECRET_CI: sentinel,
      GITHUB_TOKEN: sentinel,
      AWS_ACCESS_KEY_ID: sentinel,
      CLAWSWEEPER_CRABFLEET_SERVICE_TOKEN: sentinel,
      TELEGRAM_BOT_TOKEN: sentinel,
      TELEGRAM_E2E_STATE_DIR: credentialRoot,
      TELEGRAM_USER_DRIVER_STATE_DIR: userDriverRoot,
    },
  });
  const command = spawnSync(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');const path=require('node:path');for(const key of ['TELEGRAM_E2E_STATE_DIR','TELEGRAM_USER_DRIVER_STATE_DIR']){const root=process.env[key];if(!root)continue;for(const file of ['credentials.local.json','config.local.json','db/td_test.binlog']){try{process.stdout.write(fs.readFileSync(path.join(root,file),'utf8'))}catch{}}}process.stdout.write(JSON.stringify(process.env))",
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(command.status, 0);
  const persistedSummary = JSON.stringify({ stdout: command.stdout, stderr: command.stderr });
  assert.match(persistedSummary, /safe-value/u);
  assert.doesNotMatch(persistedSummary, new RegExp(sentinel, "u"));
  assert.doesNotMatch(persistedSummary, /broker\.example\.test/u);
  assert.doesNotMatch(persistedSummary, /telegram-command-env-test/u);
  assert.match(persistedSummary, /disposable-sut-config/u);
  fs.rmSync(credentialRoot, { recursive: true, force: true });
});
