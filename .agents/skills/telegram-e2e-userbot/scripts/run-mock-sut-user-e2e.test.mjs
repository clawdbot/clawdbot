import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertTesterMatchesLease,
  cleanupOwnedRuntime,
  createGatewayEnvironment,
  drainSutUpdates,
  fenceLeaseFailure,
  ownChild,
  removeRunnerScratch,
  runCommand,
  sanitizeChildEnvironment,
  waitForGatewayLeaseReady,
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

test("runner rejects a live tester identity that differs from the lease", () => {
  assert.throws(
    () => assertTesterMatchesLease({ id: "42" }, { testerUserId: "43" }),
    /identity does not match the lease/u,
  );
  assert.doesNotThrow(() => assertTesterMatchesLease({ id: "42" }, { testerUserId: "42" }));
});

test("successful probe cleanup removes private runner scratch without an output directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-runner-scratch-"));
  fs.writeFileSync(path.join(root, "openclaw.json"), "private config");
  removeRunnerScratch(root);
  assert.equal(fs.existsSync(root), false);
});

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

test("lease loss signals active Telegram process groups before waiting", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-concurrent-lease-fence-"));
  const cronSideEffect = path.join(temp, "cron-delivered");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const probe = ownChild(
    spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM",()=>setTimeout(()=>process.exit(0),300)); setInterval(()=>{},1000);',
      ],
      { detached: true, stdio: "ignore" },
    ),
  );
  const cron = ownChild(
    spawn(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.CRON_SIDE_EFFECT,"delivered"),150); setInterval(()=>{},1000);',
      ],
      {
        detached: true,
        env: { ...process.env, CRON_SIDE_EFFECT: cronSideEffect },
        stdio: "ignore",
      },
    ),
  );
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
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(fs.existsSync(cronSideEffect), false);
  assert.equal(logsPersisted, true);
});

test("lease loss during blocked readiness stops the gateway before polling", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-gateway-lease-fence-"));
  const pollMarker = path.join(temp, "poll-started");
  const gatewayReady = path.join(temp, "gateway-ready");
  const childScript = path.join(temp, "fixture.cjs");
  const gatewayScript = path.join(temp, "gateway.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.POLL_MARKER,"polled"),200); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    gatewayScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.GATEWAY_READY,"ready"); setInterval(()=>{},1000);',
  );
  const gatewayEnv = createGatewayEnvironment({
    baseEnv: {
      PATH: "/safe/bin",
      OPENCLAW_QA_CONVEX_SECRET_CI: "broker-secret",
      TELEGRAM_E2E_STATE_DIR: "/private/lease",
    },
    configPath: path.join(temp, "openclaw.json"),
    stateDir: path.join(temp, "state"),
    sutToken: "sut-token",
  });
  const gateway = ownChild(
    spawn(process.execPath, [gatewayScript], {
      detached: true,
      env: {
        ...process.env,
        ...gatewayEnv,
        CHILD_SCRIPT: childScript,
        GATEWAY_READY: gatewayReady,
        POLL_MARKER: pollMarker,
      },
      stdio: "ignore",
    }),
  );
  const leaseError = new Error("lease heartbeat failed during gateway readiness");
  const leaseFailure = new Promise((resolve) => {
    const poll = setInterval(() => {
      if (!fs.existsSync(gatewayReady)) return;
      clearInterval(poll);
      resolve({ type: "lease-failure", error: leaseError });
    }, 5);
  });

  await assert.rejects(
    waitForGatewayLeaseReady({
      child: gateway,
      readiness: new Promise(() => {}),
      leaseFailure,
    }),
    (error) => error === leaseError,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(gatewayEnv.PATH, "/safe/bin");
  assert.equal(gatewayEnv.OPENCLAW_QA_CONVEX_SECRET_CI, undefined);
  assert.equal(gatewayEnv.TELEGRAM_E2E_STATE_DIR, undefined);
  assert.equal(fs.existsSync(gatewayReady), true);
  assert.equal(fs.existsSync(pollMarker), false);
});

test("lease revocation between startup Bot API calls prevents update polling", async () => {
  const leaseError = new Error("lease revoked between Bot API calls");
  let healthy = true;
  let revoke;
  const whenUnhealthy = new Promise((resolve) => {
    revoke = () => {
      healthy = false;
      resolve({ type: "lease-failure", error: leaseError });
    };
  });
  const methods = [];
  const fetchImpl = async (url) => {
    methods.push(new URL(url).pathname.split("/").at(-1));
    return {
      ok: true,
      status: 200,
      json: async () => {
        revoke();
        return { ok: true, result: { url: "", pending_update_count: 0 } };
      },
    };
  };
  const lease = {
    assertHealthy: () => {
      if (!healthy) throw leaseError;
    },
    whenUnhealthy,
  };

  await assert.rejects(
    drainSutUpdates("sut-token", lease, fetchImpl),
    (error) => error === leaseError,
  );
  assert.deepEqual(methods, ["getWebhookInfo"]);
});

test("lease loss during a credential command stops every owned child before its side effect", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-lease-fence-"));
  const sideEffect = path.join(temp, "sent");
  const wrapperReady = path.join(temp, "wrapper-ready");
  const childScript = path.join(temp, "child.cjs");
  const wrapperScript = path.join(temp, "wrapper.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),200); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    wrapperScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.WRAPPER_READY,"ready"); setInterval(()=>{},1000);',
  );
  const gateway = startOwnedChild();
  const leaseError = new Error("lease revoked during credential command");
  const leaseFailure = new Promise((resolve) => {
    const deadline = Date.now() + 1_000;
    const poll = setInterval(() => {
      if (fs.existsSync(wrapperReady) || Date.now() >= deadline) {
        clearInterval(poll);
        resolve({ type: "lease-failure", error: leaseError });
      }
    }, 5);
  });

  await assert.rejects(
    runCommand(process.execPath, [wrapperScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHILD_SCRIPT: childScript,
        SIDE_EFFECT: sideEffect,
        WRAPPER_READY: wrapperReady,
      },
      leaseFailure,
      timeoutMs: 1_000,
    }),
    (error) => error === leaseError,
  );
  await exited(gateway);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fs.existsSync(wrapperReady), true);
  assert.equal(fs.existsSync(sideEffect), false);
});

test("credential command timeout stops a nested wrapper before its side effect", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-command-timeout-fence-"));
  const sideEffect = path.join(temp, "sent");
  const wrapperReady = path.join(temp, "wrapper-ready");
  const childScript = path.join(temp, "child.cjs");
  const wrapperScript = path.join(temp, "wrapper.cjs");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  fs.writeFileSync(
    childScript,
    'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),1000); setInterval(()=>{},1000);',
  );
  fs.writeFileSync(
    wrapperScript,
    'const fs=require("node:fs"); const {spawn}=require("node:child_process"); spawn(process.execPath,[process.env.CHILD_SCRIPT],{env:process.env,stdio:"ignore"}); fs.writeFileSync(process.env.WRAPPER_READY,"ready"); setInterval(()=>{},1000);',
  );

  const result = await runCommand(process.execPath, [wrapperScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHILD_SCRIPT: childScript,
      SIDE_EFFECT: sideEffect,
      WRAPPER_READY: wrapperReady,
    },
    timeoutMs: 500,
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(result.timedOut, true);
  assert.equal(fs.existsSync(wrapperReady), true);
  assert.equal(fs.existsSync(sideEffect), false);
});

test("credential-bearing child processes receive no parent control secrets", () => {
  const env = sanitizeChildEnvironment({
    PATH: "/safe/bin",
    OPENCLAW_QA_CONVEX_SECRET_CI: "broker-secret",
    GITHUB_TOKEN: "github-secret",
    TELEGRAM_E2E_STATE_DIR: "/private/lease",
    TELEGRAM_USER_DRIVER_STATE_DIR: "/private/lease/user-driver",
  });
  assert.deepEqual(env, { PATH: "/safe/bin" });
});
