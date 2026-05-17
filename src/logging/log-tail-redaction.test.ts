import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { readConfiguredLogTail } from "./log-tail.js";

const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
let tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-log-tail-redaction-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  setLoggerOverride(null);
  resetLogger();
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { force: true, recursive: true })));
  tempDirs = [];
});

describe("readConfiguredLogTail redaction", () => {
  it("redacts raw auth headers before returning log lines", async () => {
    const dir = await makeTempDir();
    const logFile = path.join(dir, "openclaw.log");
    const configFile = path.join(dir, "openclaw.json");
    const basicSecret = "c2VjcmV0OnBhc3M=";
    const openClawToken = "supersecretgatewaytoken1234567890";
    const pomeriumJwt = "eyJheaderabcd.eyJpayloadabcd.signatureabcd123456";

    await fs.writeFile(
      configFile,
      JSON.stringify({ logging: { redactSensitive: "tools" } }),
      "utf8",
    );
    await fs.writeFile(
      logFile,
      [
        `Authorization: Basic ${basicSecret}`,
        `X-OpenClaw-Token: ${openClawToken}`,
        `x-pomerium-jwt-assertion: ${pomeriumJwt}`,
        "normal diagnostic line",
      ].join("\n"),
      "utf8",
    );
    process.env.OPENCLAW_CONFIG_PATH = configFile;
    setLoggerOverride({ file: logFile });

    const payload = await readConfiguredLogTail({ limit: 10 });
    const text = payload.lines.join("\n");

    expect(text).toContain("Authorization: Basic ***");
    expect(text).toContain("X-OpenClaw-Token: supers…7890");
    expect(text).toContain("x-pomerium-jwt-assertion: eyJhea…3456");
    expect(text).toContain("normal diagnostic line");
    expect(text).not.toContain(basicSecret);
    expect(text).not.toContain(openClawToken);
    expect(text).not.toContain(pomeriumJwt);
  });
});
