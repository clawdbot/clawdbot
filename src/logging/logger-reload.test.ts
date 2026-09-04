import fs from "node:fs";
import path from "node:path";
import { Logger as TsLogger } from "tslog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import {
  applyLoggingConfig,
  flushLogger,
  getChildLogger,
  getLogger,
  resetLogger,
  toPinoLikeLogger,
} from "./logger.js";

const paths = createSuiteLogPathTracker("openclaw-logger-reload-");

beforeAll(async () => await paths.setup());
beforeEach(() => {
  resetLogger();
  vi.stubEnv("OPENCLAW_TEST_FILE_LOG", "1");
  vi.stubEnv("OPENCLAW_LOG_LEVEL", "");
});
afterEach(async () => {
  await flushLogger();
  resetLogger();
  vi.unstubAllEnvs();
});
afterAll(async () => await paths.cleanup());

describe("retained loggers after config application", () => {
  it.each([
    ["root", () => getLogger()],
    ["child", () => getChildLogger({ module: "retained" })],
    ["nested child", () => getChildLogger({ module: "retained" }).getSubLogger({ name: "nested" })],
    [
      "pino child",
      () =>
        toPinoLikeLogger(getChildLogger({ module: "retained" }), "info").child({
          component: "nested",
        }),
    ],
  ] as const)(
    "refreshes a retained %s from silent through file and level changes",
    async (_name, create) => {
      const first = paths.nextPath();
      const second = paths.nextPath();
      applyLoggingConfig({ level: "silent", file: first });
      const logger = create();
      logger.info("hidden before enable");
      applyLoggingConfig({ level: "info", file: first });
      logger.info("first target");
      logger.debug("hidden before debug");
      applyLoggingConfig({ level: "debug", file: second });
      logger.debug("second target");
      applyLoggingConfig({ level: "silent", file: second });
      logger.error("hidden after disable");
      await flushLogger();

      const firstContent = fs.readFileSync(first, "utf8");
      const secondContent = fs.readFileSync(second, "utf8");
      expect(firstContent).toContain("first target");
      expect(firstContent).not.toContain("second target");
      expect(secondContent).toContain("second target");
      expect(secondContent).not.toContain("first target");
      expect(firstContent + secondContent).not.toContain("hidden");
    },
  );

  it("preserves explicit levels and later public settings assignments in nested children", async () => {
    const first = paths.nextPath();
    const second = paths.nextPath();
    applyLoggingConfig({ level: "error", file: first });
    const logger = getChildLogger({ module: "verbose" }, { level: "debug" });
    const nested = logger.getSubLogger({ name: "nested" });
    const silent = toPinoLikeLogger(
      getChildLogger({ module: "quiet" }, { level: "silent" }),
      "silent",
    ).child({ component: "child" });
    expect(logger).toBeInstanceOf(TsLogger);
    nested.debug("explicit debug");
    logger.settings.minLevel = 4;
    applyLoggingConfig({ level: "trace", file: second });
    nested.debug("hidden after assignment");
    nested.warn("assigned warning");
    silent.error("hidden explicit silent");
    expect(silent.level).toBe("silent");
    await flushLogger();

    expect(fs.readFileSync(first, "utf8")).toContain("explicit debug");
    const content = fs.readFileSync(second, "utf8");
    expect(content).toContain("assigned warning");
    expect(content).not.toContain("hidden");
  });

  it("applies a new file size limit to an existing child", async () => {
    const file = paths.nextPath();
    applyLoggingConfig({ level: "info", file, maxFileBytes: 1_000_000 });
    const logger = getChildLogger({ module: "rotation" });
    logger.info("before smaller limit");
    await flushLogger();
    applyLoggingConfig({ level: "info", file, maxFileBytes: 1 });
    logger.info("after smaller limit");
    await flushLogger();

    const archive = path.join(path.dirname(file), `${path.basename(file, ".log")}.1.log`);
    expect(fs.readFileSync(archive, "utf8")).toContain("before smaller limit");
    expect(fs.readFileSync(file, "utf8")).toContain("after smaller limit");
  });

  it("leaves third-party tslog instances and pino adapters under their own policy", () => {
    const logger = new TsLogger<{ date?: Date } & Record<string, unknown>>({
      minLevel: 4,
      type: "hidden",
    });
    const records: unknown[] = [];
    logger.attachTransport((record) => records.push(record));
    const child = toPinoLikeLogger(logger, "warn").child({ component: "external" });
    applyLoggingConfig({ level: "silent", file: paths.nextPath() });
    child.info("hidden external info");
    child.warn("external warning");
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).toContain("external warning");
  });

  it("keeps Pino inheritance when the adapter comes from another module copy", async () => {
    const file = paths.nextPath();
    applyLoggingConfig({ level: "silent", file });
    const logger = getChildLogger({ module: "retained-module" });
    vi.resetModules();
    const reloaded = await import("./logger.js");
    const child = reloaded.toPinoLikeLogger(logger, "info").child({ component: "later-copy" });

    reloaded.applyLoggingConfig({ level: "info", file });
    child.info("enabled through another module copy");
    await flushLogger();

    expect(fs.readFileSync(file, "utf8")).toContain("enabled through another module copy");
  });
});
