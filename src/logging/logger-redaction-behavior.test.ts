import fs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

const secret = "sk-testsecret1234567890abcd";
const logPathTracker = createSuiteLogPathTracker("openclaw-log-redaction-");
const originalConfigPath = process.env.OPENCLAW_CONFIG_PATH;
const originalTestFileLog = process.env.OPENCLAW_TEST_FILE_LOG;

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(() => {
  if (originalConfigPath === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = originalConfigPath;
  }
  if (originalTestFileLog === undefined) {
    delete process.env.OPENCLAW_TEST_FILE_LOG;
  } else {
    process.env.OPENCLAW_TEST_FILE_LOG = originalTestFileLog;
  }
  resetLogger();
  setLoggerOverride(null);
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("file log redaction", () => {
  it("redacts credential fields before writing JSONL file logs", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info({ apiKey: secret, message: "provider configured" });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("provider configured");
    expect(content).toContain('"apiKey"');
    expect(content).not.toContain(secret);
  });

  it("redacts bearer tokens in file log message strings", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().warn({ message: `Authorization: Bearer ${secret}` });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("Authorization: Bearer");
    expect(content).not.toContain(secret);
  });

  it("uses logging.file from the active config path", () => {
    const logPath = logPathTracker.nextPath();
    const configPath = logPathTracker.nextPath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: {
          level: "info",
          file: logPath,
        },
      }),
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_TEST_FILE_LOG = "1";

    getLogger().info({ message: "configured log path works" });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("configured log path works");
  });
});
