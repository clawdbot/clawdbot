// Verifies config IO warning caches stay bounded across process lifetime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInvalidConfigError, throwInvalidConfig } from "./io.invalid-config.js";
import {
  loggedConfigWarningFingerprints,
  loggedInvalidConfigs,
  warnedFutureTouchedVersions,
} from "./io.state.js";
import { logConfigWarningsOnce, warnIfConfigFromFuture } from "./io.warnings.js";

const CACHE_MAX_SIZE = 4096;

beforeEach(() => {
  loggedInvalidConfigs.clear();
  loggedConfigWarningFingerprints.clear();
  warnedFutureTouchedVersions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function recordInvalidConfig(configPath: string, logger: Pick<typeof console, "error">): void {
  try {
    throwInvalidConfig({
      configPath,
      issues: [{ path: "root", message: "invalid" }],
      logger,
      loggedConfigPaths: loggedInvalidConfigs,
    });
  } catch (error) {
    if (isInvalidConfigError(error)) {
      return;
    }
    throw error;
  }
  throw new Error("expected invalid config error");
}

describe("config IO state caches", () => {
  it("keeps hot invalid-config paths while evicted paths re-warn", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      recordInvalidConfig(`/config-${i}.json`, console);
    }

    recordInvalidConfig("/config-0.json", console);
    recordInvalidConfig("/overflow.json", console);
    recordInvalidConfig("/config-1.json", console);

    expect(loggedInvalidConfigs.size()).toBe(CACHE_MAX_SIZE);
    expect(errorSpy).toHaveBeenCalledTimes(CACHE_MAX_SIZE + 2);
  });

  it("keeps hot future versions while evicted versions re-warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warnVersion = (version: string) =>
      warnIfConfigFromFuture(
        { meta: { lastTouchedVersion: version } } as Parameters<typeof warnIfConfigFromFuture>[0],
        console,
      );
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      warnVersion(`3000.1.${i}`);
    }

    warnVersion("3000.1.0");
    warnVersion("3000.1.9999");
    warnVersion("3000.1.1");

    expect(warnedFutureTouchedVersions.size()).toBe(CACHE_MAX_SIZE);
    expect(warnSpy).toHaveBeenCalledTimes(CACHE_MAX_SIZE + 2);
  });

  it("retains a hot warning fingerprint while evicting and re-warning the cold path", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warnPath = (configPath: string) =>
      logConfigWarningsOnce({
        configPath,
        warnings: [{ path: "root", message: "warning" }],
        logger: console,
      });
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      warnPath(`/config-${i}.json`);
    }

    warnPath("/config-0.json");
    warnPath("/overflow.json");
    expect(loggedConfigWarningFingerprints.has("/config-0.json")).toBe(true);
    expect(loggedConfigWarningFingerprints.has("/config-1.json")).toBe(false);

    warnPath("/config-1.json");
    expect(loggedConfigWarningFingerprints.size).toBe(CACHE_MAX_SIZE);
    expect(warnSpy).toHaveBeenCalledTimes(CACHE_MAX_SIZE + 2);
  });
});
