#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTelegramTestApiProxy } from "./telegram-test-api-proxy.mjs";
import { acquireTelegramTestCredential } from "./telegram-test-credential.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_DRIVER_PATH = path.join(SKILL_DIR, "scripts", "user-driver.py");
const credential = await acquireTelegramTestCredential();
let proxy;
try {
  const driverEnv = { ...process.env, ...credential.driverEnv };
  const status = spawnSync("uv", ["run", USER_DRIVER_PATH, "status", "--json"], {
    env: driverEnv,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (status.status !== 0) throw new Error("TDLib Test Server user session is not authorized.");
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
  proxy = await startTelegramTestApiProxy();
  const response = await fetch(`${proxy.apiRoot}/bot${credential.sutToken}/getMe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const bot = await response.json().catch(() => ({}));
  if (!response.ok || bot.ok !== true) {
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
  const membershipResponse = await fetch(
    `${proxy.apiRoot}/bot${credential.sutToken}/getChatMember`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: credential.groupId,
        user_id: credential.sutBotId,
      }),
    },
  );
  const membership = await membershipResponse.json().catch(() => ({}));
  if (
    !membershipResponse.ok ||
    membership.ok !== true ||
    !["administrator", "creator", "member"].includes(membership.result?.status)
  ) {
    throw new Error("Telegram Test Server bot is not an active member of the test group.");
  }
  console.log(
    JSON.stringify({
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
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  process.exitCode = 1;
} finally {
  await proxy?.close();
  await credential.release();
}
