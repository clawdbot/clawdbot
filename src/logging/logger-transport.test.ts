import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";

type LoggerModule = typeof import("./logger.js");

const logPathTracker = createSuiteLogPathTracker("openclaw-logger-transport-");
const importedModules: LoggerModule[] = [];

async function importLoggerModule(scope: string): Promise<LoggerModule> {
  const module = await importFreshModule<LoggerModule>(
    import.meta.url,
    `./logger.js?scope=${scope}`,
  );
  importedModules.push(module);
  module.setLoggerOverride({
    level: "info",
    file: logPathTracker.nextPath(),
  });
  return module;
}

describe("logger transport registry", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  afterEach(() => {
    while (importedModules.length > 0) {
      const module = importedModules.pop();
      module?.resetLogger();
      module?.setLoggerOverride(null);
    }
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("does not expose production or test log transport registration", async () => {
    const loggerModule = await importLoggerModule("public-api");

    expect(
      (loggerModule as unknown as Record<string, unknown>).registerLogTransport,
    ).toBeUndefined();
    expect(
      (loggerModule.__test__ as unknown as Record<string, unknown>).registerLogTransportForTest,
    ).toBeUndefined();
  });

  it("does not publish mutable log transport state on a well-known global symbol", async () => {
    await importLoggerModule("global-state");

    expect(
      (globalThis as typeof globalThis & Record<PropertyKey, unknown>)[
        Symbol.for("openclaw.logging.transports")
      ],
    ).toBeUndefined();
  });
});
