import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupOwnedRuntime,
  drainSutUpdates,
  fenceLeaseFailure,
  ownChild,
  runCommand,
  sanitizeChildEnvironment,
  waitForGatewayLeaseReady,
  writeConfig,
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

test("lease loss during blocked readiness stops the gateway before polling", async (context) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-gateway-lease-fence-"));
  const pollMarker = path.join(temp, "poll-started");
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const gateway = ownChild(
    spawn(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.POLL_MARKER,"polled"),200); setInterval(()=>{},1000);',
      ],
      {
        detached: true,
        env: { ...process.env, POLL_MARKER: pollMarker },
        stdio: "ignore",
      },
    ),
  );
  const leaseError = new Error("lease heartbeat failed during gateway readiness");
  const leaseFailure = new Promise((resolve) =>
    setTimeout(() => resolve({ type: "lease-failure", error: leaseError }), 20),
  );

  await assert.rejects(
    waitForGatewayLeaseReady({
      child: gateway,
      readiness: new Promise(() => {}),
      leaseFailure,
    }),
    (error) => error === leaseError,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
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
  context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const gateway = startOwnedChild();
  const leaseError = new Error("lease revoked during credential command");
  const leaseFailure = new Promise((resolve) =>
    setTimeout(() => resolve({ type: "lease-failure", error: leaseError }), 20),
  );

  await assert.rejects(
    runCommand(
      process.execPath,
      [
        "-e",
        'const fs=require("node:fs"); setTimeout(()=>fs.writeFileSync(process.env.SIDE_EFFECT,"sent"),200); setInterval(()=>{},1000);',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, SIDE_EFFECT: sideEffect },
        leaseFailure,
        timeoutMs: 1_000,
      },
    ),
    (error) => error === leaseError,
  );
  await exited(gateway);
  await new Promise((resolve) => setTimeout(resolve, 250));
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

test("generated Codex fixture config clears Telegram lease state before initialization", (context) => {
  const generated = writeConfig({
    backend: "codex-fixture",
    gatewayPort: 19879,
    groupId: "-1001",
    mockPort: 19882,
    sourceGateway: false,
    telegramApiRoot: "http://127.0.0.1:19881",
    testerId: "123",
  });
  context.after(() => fs.rmSync(generated.root, { recursive: true, force: true }));
  const integrationScript = `
    import fs from "node:fs";
    import { CodexAppServerClient } from "./extensions/codex/src/app-server/client.ts";
    import { assertCodexThreadStartResponse } from "./extensions/codex/src/app-server/protocol-validators.ts";
    import { CODEX_APP_SERVER_VERSION } from "./extensions/codex/src/app-server/version.ts";
    const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_E2E_CODEX_CONFIG_PATH, "utf8"));
    const appServer = config.plugins.entries.codex.config.appServer;
    const client = CodexAppServerClient.start({
      transport: "stdio",
      command: appServer.command,
      commandSource: "custom",
      args: appServer.args,
      clearEnv: appServer.clearEnv,
      headers: {},
      env: {
        OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG: process.env.OPENCLAW_E2E_CODEX_LOG_PATH,
        TELEGRAM_BOT_TOKEN: "secret-sentinel",
        TELEGRAM_E2E_STATE_DIR: "/private/lease",
        TELEGRAM_USER_DRIVER_STATE_DIR: "/private/lease/user-driver",
        TELEGRAM_E2E_SUT_BOT_TOKEN: "secondary-secret-sentinel",
      },
    });
    try {
      await client.initialize();
      if (client.getServerVersion() !== CODEX_APP_SERVER_VERSION) throw new Error("version mismatch");
      const started = assertCodexThreadStartResponse(
        await client.request("thread/start", {}, { timeoutMs: 2_000 }),
      );
      if (started.thread.id !== "thread-telegram-request-user-input") throw new Error("thread mismatch");
    } finally {
      await client.closeAndWait();
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--import", path.resolve("scripts/tsx.mjs"), "--input-type=module", "-e", integrationScript],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_E2E_CODEX_CONFIG_PATH: generated.configPath,
        OPENCLAW_E2E_CODEX_LOG_PATH: path.join(generated.root, "messages.ndjson"),
      },
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
