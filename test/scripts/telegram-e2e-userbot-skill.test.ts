import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeConfig } from "../../.agents/skills/telegram-e2e-userbot/scripts/run-mock-sut-user-e2e.mjs";
import { CodexAppServerClient } from "../../extensions/codex/src/app-server/client.js";
import { CODEX_APP_SERVER_VERSION } from "../../extensions/codex/src/app-server/version.js";

const scriptsDir = path.resolve(".agents/skills/telegram-e2e-userbot/scripts");

function requireSuccess(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
  });
  expect(result.error).toBeUndefined();
  expect(`${result.stdout}${result.stderr}`).not.toContain("not ok");
  expect(result.status, `${command} ${args.join(" ")}\n${result.stdout}${result.stderr}`).toBe(0);
}

describe("repository Telegram E2E skill", () => {
  it("replaces the obsolete Telegram Crabbox recorder skill", () => {
    expect(fs.existsSync(".agents/skills/telegram-crabbox-e2e-proof")).toBe(false);
  });

  it("initializes the Codex fixture through the OpenClaw app-server client", async () => {
    const generated = writeConfig({
      backend: "codex-fixture",
      gatewayPort: 19879,
      groupId: "-1001",
      mockPort: 19882,
      sourceGateway: false,
      telegramApiRoot: "http://127.0.0.1:19881",
      testerId: "123",
    });
    const config = JSON.parse(fs.readFileSync(generated.configPath, "utf8"));
    const appServer = config.plugins.entries.codex.config.appServer;
    const client = CodexAppServerClient.start({
      transport: "stdio",
      command: appServer.command,
      commandSource: "custom",
      args: appServer.args,
      clearEnv: appServer.clearEnv,
      headers: {},
      env: {
        OPENCLAW_CODEX_REQUEST_USER_INPUT_LOG: path.join(generated.root, "messages.ndjson"),
        TELEGRAM_BOT_TOKEN: "secret-sentinel",
        TELEGRAM_E2E_STATE_DIR: "/private/lease",
        TELEGRAM_USER_DRIVER_STATE_DIR: "/private/lease/user-driver",
        TELEGRAM_E2E_SUT_BOT_TOKEN: "secondary-secret-sentinel",
      },
    });
    try {
      await client.initialize();
      expect(client.getServerVersion()).toBe(CODEX_APP_SERVER_VERSION);
      await expect(client.request("thread/start", {}, { timeoutMs: 2_000 })).resolves.toMatchObject(
        {
          thread: { id: "thread-telegram-request-user-input" },
        },
      );
    } finally {
      await client.closeAndWait();
      fs.rmSync(generated.root, { recursive: true, force: true });
    }
  });

  it("passes its Node test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.mjs"))
      .toSorted()
      .map((entry) => path.join(scriptsDir, entry));
    expect(tests.length).toBeGreaterThan(0);
    requireSuccess(process.execPath, ["--test", ...tests]);
  });

  it("passes its Python test suite", () => {
    const tests = fs
      .readdirSync(scriptsDir)
      .filter((entry) => entry.endsWith(".test.py"))
      .toSorted();
    expect(tests.length).toBeGreaterThan(0);
    for (const test of tests) {
      requireSuccess("python3", [path.join(scriptsDir, test)]);
    }
  });
});
