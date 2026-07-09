// Logger redaction behavior tests cover secret scrubbing before log writes.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
import { getChildLogger, getLogger, resetLogger, setLoggerOverride } from "../logging.js";
import { withEnv } from "../test-utils/env.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { testApi as loggerTest } from "./logger.js";
import { createDiagnosticLogRecordCapture } from "./test-helpers/diagnostic-log-capture.js";

const secret = "sk-testsecret1234567890abcd";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const logPathTracker = createSuiteLogPathTracker("openclaw-log-redaction-");

beforeAll(async () => {
  await logPathTracker.setup();
});

beforeEach(() => {
  resetDiagnosticEventsForTest();
});

afterEach(() => {
  resetDiagnosticEventsForTest();
  resetDiagnosticTraceContextForTest();
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

  it("redacts sensitive structured fields before emitting diagnostic log records", async () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const capture = createDiagnosticLogRecordCapture();
    try {
      getLogger().info(
        {
          password: "hunter2",
          token: "token-value-1234567890",
        },
        "credential diagnostic",
      );
      await capture.flush();

      const serialized = JSON.stringify(capture.records);
      expect(serialized).toContain("credential diagnostic");
      expect(serialized).not.toContain("hunter2");
      expect(serialized).not.toContain("token-value-1234567890");
      expect(capture.records.at(-1)?.attributes?.password).toBe("***");
    } finally {
      capture.cleanup();
    }
  });

  it("honors logging redaction opt-out for structured file log fields", () => {
    const logPath = logPathTracker.nextPath();
    const configPath = logPathTracker.nextPath();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        logging: {
          redactSensitive: "off",
        },
      }),
    );
    withEnv({ OPENCLAW_CONFIG_PATH: configPath }, () => {
      setLoggerOverride({ level: "info", file: logPath });

      getLogger().info({
        token: "token-value-1234567890",
        access: "ya29.fake-access-token-with-enough-length",
        password: "abcd-efgh-ijkl-mnop",
        message: `Authorization: Bearer ${secret}`,
      });
    });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("token-value-1234567890");
    expect(content).toContain("ya29.fake-access-token-with-enough-length");
    expect(content).toContain("abcd-efgh-ijkl-mnop");
    expect(content).toContain(secret);
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
    withEnv({ OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FILE_LOG: "1" }, () => {
      getLogger().info({ message: "configured log path works" });
    });

    const content = fs.readFileSync(logPath, "utf8");
    expect(content).toContain("configured log path works");
  });

  it("expands leading tilde in logging.file", () => {
    const home = path.join(path.dirname(logPathTracker.nextPath()), "home");

    withEnv({ HOME: home }, () => {
      expect(loggerTest.resolveActiveLogFile("~/custom-openclaw.log")).toBe(
        path.join(home, "custom-openclaw.log"),
      );
    });
  });

  it("writes trace context as top-level JSONL fields", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const logger = getChildLogger({
      subsystem: "gateway",
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
    });

    logger.info({ route: "/api/health" }, "request completed");

    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.traceId).toBe(TRACE_ID);
    expect(record.spanId).toBe(SPAN_ID);
  });

  it("writes active request trace context as top-level JSONL fields", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const trace = createDiagnosticTraceContext({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });

    runWithDiagnosticTraceContext(trace, () => {
      getLogger().info({ route: "/api/health" }, "request completed");
    });

    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.traceId).toBe(TRACE_ID);
    expect(record.spanId).toBe(SPAN_ID);
  });

  it("writes hostname and flattened message as top-level JSONL fields", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });

    getLogger().info({ route: "/api/health" }, "request completed");

    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.hostname).toBeTypeOf("string");
    expect(record.hostname).not.toBe("");
    expect(record.message).toBe("request completed");
  });

  it("keeps bounded file-log messages UTF-16 safe", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const prefix = "x".repeat(4_095);

    getLogger().info(`${prefix}😀tail`);

    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.message).toBe(`${prefix}...(truncated)`);
  });

  it("retries hostname resolution after an empty value and caches the first real value", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const hostnames = ["", "lr-macbook", "changed-host"];
    const resolvedHostnames: string[] = [];
    loggerTest.setHostnameResolverForTests(() => {
      const hostname = hostnames.shift() ?? "changed-host";
      resolvedHostnames.push(hostname);
      return hostname;
    });

    getLogger().info({ route: "/api/health" }, "first request");
    getLogger().info({ route: "/api/health" }, "second request");
    getLogger().info({ route: "/api/health" }, "third request");

    const records = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    expect(resolvedHostnames).toEqual(["", "lr-macbook"]);
    expect(records[0]?.hostname).toBe("unknown");
    expect(records[0]?.message).toBe("first request");
    expect(records[1]?.hostname).toBe("lr-macbook");
    expect(records[1]?.message).toBe("second request");
    expect(records[2]?.hostname).toBe("lr-macbook");
    expect(records[2]?.message).toBe("third request");
    expect((records[1]?.["_meta"] as Record<string, unknown> | undefined)?.hostname).toBe(
      "lr-macbook",
    );
  });

  it("promotes agent, session, and channel context to top-level JSONL fields", () => {
    const logPath = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", file: logPath });
    const logger = getChildLogger({
      agentId: "agent-main",
      messageProvider: "discord",
    });

    logger.info({ sessionKey: "agent:main:discord:channel:c1" }, "session routed");

    const [line] = fs.readFileSync(logPath, "utf8").trim().split("\n");
    const record = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(record.agent_id).toBe("agent-main");
    expect(record.session_id).toBe("agent:main:discord:channel:c1");
    expect(record.channel).toBe("discord");
    expect(record.message).toBe("session routed");
  });
});
