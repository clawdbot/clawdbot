// Verifies invalid-config errors include stable codes and details.
import { describe, expect, it, vi } from "vitest";
import {
  createInvalidConfigError,
  formatInvalidConfigDetails,
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
    const err = createInvalidConfigError("/tmp/openclaw.json", "- gateway.port: bad") as Error & {
      code?: string;
      details?: string;
    };

    expect(err.message).toBe("Invalid config at /tmp/openclaw.json:\n- gateway.port: bad");
    expect(err.name).toBe("InvalidConfigError");
    expect(err.code).toBe("INVALID_CONFIG");
    expect(err.details).toBe("- gateway.port: bad");
    expect(isInvalidConfigError(err)).toBe(true);
    expect(
      isInvalidConfigError(Object.assign(new Error(err.message), { code: "INVALID_CONFIG" })),
    ).toBe(true);
    expect(isInvalidConfigError(new Error(err.message))).toBe(false);
  });

  it("throws INVALID_CONFIG after logging the formatted details once per path", () => {
    const logger = { error: vi.fn() };
    const loggedConfigPaths = new Set<string>();
    const throwInvalid = () =>
      throwInvalidConfig({
        configPath: "/tmp/openclaw.json",
        issues: [{ path: "nope", message: "Unknown key(s): nope" }],
        logger,
        loggedConfigPaths,
      });

    expect(throwInvalid).toThrowError(
      "Invalid config at /tmp/openclaw.json:\n- nope: Unknown key(s): nope",
    );
    expect(throwInvalid).toThrowError(
      "Invalid config at /tmp/openclaw.json:\n- nope: Unknown key(s): nope",
    );
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      "Invalid config at /tmp/openclaw.json:\\n- nope: Unknown key(s): nope",
    );
  });
});
