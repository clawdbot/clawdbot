#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fetchWithLease, runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { startTelegramTestApiProxy } from "./telegram-test-api-proxy.mjs";
import { acquireTelegramTestCredential } from "./telegram-test-credential.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_DRIVER_PATH = path.join(SKILL_DIR, "scripts", "user-driver.py");

export async function runTelegramTestDoctor({
  acquireCredential = acquireTelegramTestCredential,
  fetchImpl = fetch,
  runCommandImpl = runCommand,
  startProxy = startTelegramTestApiProxy,
} = {}) {
  const credential = await acquireCredential();
  const leaseFailure = credential.whenLeaseUnhealthy.then((error) => ({
    type: "lease-failure",
    error,
  }));
  const lease = { assertHealthy: credential.assertLeaseHealthy, whenUnhealthy: leaseFailure };
  let proxy;
  try {
    const driverEnv = { ...sanitizeChildEnvironment(), ...credential.driverEnv };
    const status = await runCommandImpl("uv", ["run", USER_DRIVER_PATH, "status", "--json"], {
      cwd: process.cwd(),
      env: driverEnv,
      leaseFailure,
      timeoutMs: 30_000,
    });
    if (status.status !== 0 || status.timedOut) {
      throw new Error("TDLib Test Server user session is not authorized.");
    }
    const driver = JSON.parse(status.stdout);
    if (
      driver.ok !== true ||
      driver.authorized !== true ||
      driver.testDc !== true ||
      driver.tdlibVersion !== credential.tdlibVersion ||
      String(driver.user?.id) !== credential.testerUserId
    ) {
      throw new Error("TDLib Test Server user identity does not match the lease.");
    }
    proxy = await startProxy();
    lease.assertHealthy();
    const botResponse = await fetchWithLease(
      `${proxy.apiRoot}/bot${credential.sutToken}/getMe`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      lease,
      fetchImpl,
    );
    const bot = await botResponse.json().catch(() => ({}));
    lease.assertHealthy();
    if (!botResponse.ok || bot.ok !== true) {
      throw new Error("Telegram Test Server Bot API proxy request failed.");
    }
    if (
      String(bot.result?.id) !== credential.sutBotId ||
      bot.result?.username !== credential.sutUsername
    ) {
      throw new Error("Telegram Test Server bot identity does not match the lease.");
    }
    if (bot.result?.can_read_all_group_messages !== true) {
      throw new Error("Telegram Test Server bot group privacy is enabled.");
    }
    const membershipResponse = await fetchWithLease(
      `${proxy.apiRoot}/bot${credential.sutToken}/getChatMember`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: credential.groupId,
          user_id: credential.sutBotId,
        }),
      },
      lease,
      fetchImpl,
    );
    const membership = await membershipResponse.json().catch(() => ({}));
    lease.assertHealthy();
    if (
      !membershipResponse.ok ||
      membership.ok !== true ||
      !["administrator", "creator", "member"].includes(membership.result?.status)
    ) {
      throw new Error("Telegram Test Server bot is not an active member of the test group.");
    }
    return {
      ok: true,
      credentialSource: "convex",
      credentialLoaded: true,
      isolatedTdlibState: true,
      testDc: true,
      tdlibAuthorized: true,
      botApiProxy: true,
      sutBot: true,
      groupPrivacyDisabled: true,
      groupMembership: true,
    };
  } finally {
    await proxy?.close();
    await credential.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTelegramTestDoctor()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    });
}
