// Verifies invalid-config errors include stable codes and details.
import { describe, expect, it, vi } from "vitest";
import { createDedupeCache } from "../infra/dedupe.js";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
  isDoctorRecoverableInvalidConfigError,
  isInvalidConfigError,
  throwInvalidConfig,
} from "./io.invalid-config.js";

describe("config io invalid config formatting", () => {
  it("formats issue details with sanitized paths and messages", () => {
    const details = formatInvalidConfigDetails([
      {
        path: "gateway.port",
        message: 'Expected number\\nreceived "bad"',
      },
      {
        path: "",
        message: "root problem",
      },
    ]);

    expect(details).toContain("- gateway.port:");
    expect(details).toContain("Expected number");
    expect(details).toContain("received");
    expect(details).toContain("- <root>: root problem");
  });

  it("creates INVALID_CONFIG errors with inline details", () => {
    const err = createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: bad");

    expect(err.message).toBe("Invalid config at /tmp/openclaw.json:\n- gateway.port: bad");
    expect(err.name).toBe("InvalidConfigError");
    expect(err.code).toBe("INVALID_CONFIG");
    expect(err.details).toBe("- gateway.port: bad");
    expect(isInvalidConfigError(err)).toBe(true);
    expect(isDoctorRecoverableInvalidConfigError(err)).toBe(true);
    expect(
      isDoctorRecoverableInvalidConfigError(
        createInvalidConfigError("/tmp/openclaw.json", "manual repair", {
          recovery: "manual",
        }),
      ),
    ).toBe(false);
    expect(
      isInvalidConfigError(Object.assign(new Error(err.message), { code: "INVALID_CONFIG" })),
    ).toBe(true);
    expect(isInvalidConfigError(new Error(err.message))).toBe(false);
  });

  it("throws INVALID_CONFIG after logging each distinct diagnostic once", () => {
    const logger = { error: vi.fn() };
    const loggedConfigPaths = createDedupeCache({ ttlMs: 0, maxSize: 4096 });
    const throwInvalid = (message: string) =>
      throwInvalidConfig({
        configPath: "/tmp/openclaw.json",
        issues: [{ path: "nope", message }],
        logger,
        loggedConfigPaths,
      });

    for (const message of ["first error", "first error", "second error", "second error"]) {
      expect(() => throwInvalid(message)).toThrowError(
        `Invalid config at /tmp/openclaw.json:\n- nope: ${message}`,
      );
    }
    expect(logger.error.mock.calls).toEqual([
      ["Invalid config at /tmp/openclaw.json:\n- nope: first error"],
      ["Invalid config at /tmp/openclaw.json:\n- nope: second error"],
    ]);
  });

  it("retries diagnostic emission after the logger throws", () => {
    const logger = { error: vi.fn() };
    logger.error.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    const loggedConfigPaths = createDedupeCache({ ttlMs: 0, maxSize: 4096 });
    const throwInvalid = () =>
      throwInvalidConfig({
        configPath: "/tmp/openclaw.json",
        issues: [{ path: "nope", message: "invalid" }],
        logger,
        loggedConfigPaths,
      });
    expect(throwInvalid).toThrow("logger unavailable");
    expect(throwInvalid).toThrow("Invalid config at /tmp/openclaw.json:");
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
