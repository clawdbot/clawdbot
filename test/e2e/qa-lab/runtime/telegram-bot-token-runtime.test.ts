import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTelegramBotTokenRuntime, testing } from "./telegram-bot-token-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("telegram bot token runtime evidence", () => {
  it("resolves only dedicated leased credentials", () => {
    expect(
      testing.resolveLeasedToken({
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "leased-token",
        TELEGRAM_E2E_SUT_BOT_TOKEN: "secondary-leased-token",
        TELEGRAM_BOT_TOKEN: "generic-token",
      }),
    ).toEqual({ key: "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN", token: "leased-token" });
  });

  it("writes blocked evidence without a dedicated credential", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-bot-token-"));
    tempDirs.push(artifactBase);
    const evidence = await runTelegramBotTokenRuntime(
      { artifactBase, repoRoot: process.cwd(), startupTimeoutMs: 100 },
      { TELEGRAM_BOT_TOKEN: "generic-token" },
    );

    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const log = await fs.readFile(path.join(artifactBase, "telegram-bot-token.log"), "utf8");
    expect(log).toContain("blocked");
    expect(log).not.toContain("generic-token");
  });

  it("bounds monitor shutdown", async () => {
    await expect(testing.waitForMonitorShutdown(new Promise(() => {}), 10)).rejects.toThrow(
      "Telegram runtime shutdown timed out",
    );
  });
});
